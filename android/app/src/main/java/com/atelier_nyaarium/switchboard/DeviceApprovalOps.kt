package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalJoin
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** The "Add a device" surface: a held device arms a one-time approval window and a fresh device
 * joins it, all keyed off the console-approval broker (no admin round trip). */
internal class DeviceApprovalOps(private val repo: ChatRepository) {
	////////////////////////////////
	//  Add a device (USER self-enroll: the owner authorizes their OWN fresh device, no admin)

	/** evie's public device-approval reach for the authorize-console QR, or null when this network has
	 * no public ingress (the Add-a-device entry is then shown disabled). */
	fun deviceApprovalReach(): String? =
		runCatching { repo.store.load()?.let { Provisioning.parse(it) } }.getOrNull()?.deviceApprovalReach?.takeIf { it.isNotEmpty() }

	/** The Router cert fingerprint to pin the reach against, empty when the reach is the k8s ingress. */
	private fun routerCertFp(): String =
		runCatching { repo.store.load()?.let { Provisioning.parse(it) } }.getOrNull()?.routerCertFp ?: ""

	/** HELD device: arm a one-time approval window and build the authorize-console QR. The QR carries
	 * PUBLIC material only (owner keys + Domain + the reach/token/nonce), never an SA token. Fails when
	 * the network has no public ingress or its Domain is not yet confirmed by a local session. */
	suspend fun armDeviceApproval(): Result<DeviceApprovalArmed> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val reach = deviceApprovalReach() ?: error("This network has no device-approval reach configured.")
			val domainId = repo.confirmedDomainId() ?: error("Your Domain isn't confirmed yet - open a session first.")
			val approvalId = repo.federation.freshApprovalToken()
			val nonce = repo.federation.freshApprovalToken()
			val result = repo.client().postConsoleApproval(ConsoleApprovalOp.Arm(approvalId = approvalId, nonce = nonce))
			if (!result.ok) error(result.error ?: "Couldn't arm the approval window.")
			val qr = JSONObject()
				.put("type", "authorize-console")
				.put("domainId", domainId)
				.put("signPub", repo.federation.ownerSignPub())
				.put("boxPub", repo.federation.ownerBoxPub())
				.put("approvalId", approvalId)
				.put("nonce", nonce)
				.put("reach", reach)
				// A fresh device holds no provisioning record, so the QR is the only place it can
				// learn which cert to pin against a self-signed Router. Empty for a k8s reach.
				.put("reachCertFp", routerCertFp())
				.toString()
			DeviceApprovalArmed(approvalId, nonce, qr)
		}
	}

	/** HELD device: poll the window for the fresh device's join (its generated console keys). Null
	 * until it joins, so the screen keeps polling. */
	suspend fun pollDeviceApproval(approvalId: String): Result<ConsoleApprovalJoin?> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val result = repo.client().postConsoleApproval(ConsoleApprovalOp.Poll(approvalId = approvalId))
			if (!result.ok) error(result.error ?: "approval window closed")
			result.join
		}
	}

	/** HELD device: approve the joined device. Owner-signs a kind:console admission for its keys and
	 * submits it (the existing submit_admission path), then seals the console transport to its box key
	 * and parks it for the device to fetch. The biometric gate is applied at the UI call site. */
	suspend fun approveDevice(approvalId: String, join: ConsoleApprovalJoin): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val signed = repo.federation.admitConsole(join.newSignPub, join.newBoxPub, System.currentTimeMillis())
			if (!repo.ownerFacts.submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitAdmission(it)) }, repo.federation::mergeAdmission, "Approve failed")) {
				error(repo._state.value.error ?: "The server rejected the new device.")
			}
			val transport = buildConsoleTransport()
			val plain = wireJson.encodeToString(ConsoleTransport.serializer(), transport).toByteArray(Charsets.UTF_8)
			val sealed = repo.federation.sealConsoleTransport(join.newBoxPub, plain)
			val result = repo.client().postConsoleApproval(ConsoleApprovalOp.Approve(approvalId = approvalId, sealed = sealed))
			if (!result.ok) error(result.error ?: "Couldn't deliver the sealed transport.")
			Unit
		}
	}

	/** HELD device: tear down the approval window when the owner leaves the screen (best-effort). */
	suspend fun cancelDeviceApproval(approvalId: String) {
		withContext(Dispatchers.IO) {
			runCatchingCancellable { repo.client().postConsoleApproval(ConsoleApprovalOp.Cancel(approvalId = approvalId)) }
		}
	}

	/** The console transport the held device seals to a new device: its own provisioning creds plus the
	 * owner's synced keyring + route Gateway, so the new device can seal to the Gateway the owner
	 * already admitted without holding the owner key to re-sync the keyring itself. */
	private fun buildConsoleTransport(): ConsoleTransport {
		val prov = Provisioning.parse(repo.store.load() ?: error("not provisioned"))
		return ConsoleTransport(
			transport = prov.transport,
			apiUrl = prov.apiUrl,
			caPem = prov.caPem,
			saToken = prov.saToken,
			routerUrl = prov.routerUrl,
			routerCertFp = prov.routerCertFp,
			appToken = prov.appToken,
			namespace = prov.namespace,
			service = prov.service,
			port = prov.port.toLong(),
			domainId = repo.confirmedDomainId(),
			gatewayId = repo.localGatewayId.takeIf { it.isNotEmpty() } ?: repo.store.loadGatewayId().takeIf { it.isNotEmpty() },
			domainVersion = repo.store.loadDomainVersion().ifEmpty { null },
			domain = repo.federation.keyring().snapshot,
		)
	}

	/** Parse a scanned authorize-console QR, or null if it is not one. The owner signPub is pinned to
	 * verify the sealed reply; its fingerprint is shown so the human confirms the network. */
	suspend fun parseAuthorizeConsole(scanned: String): ScannedDeviceApproval? = withContext(Dispatchers.IO) {
		runCatching {
			val j = JSONObject(scanned.trim())
			require(j.optString("type") == "authorize-console")
			ScannedDeviceApproval(
				domainId = j.getString("domainId"),
				ownerSignPub = j.getString("signPub"),
				ownerBoxPub = j.getString("boxPub"),
				approvalId = j.getString("approvalId"),
				nonce = j.getString("nonce"),
				reach = j.getString("reach"),
				reachCertFp = j.optString("reachCertFp"),
				// N's OWN console key fingerprint - the SAME value the held device renders (it shows
				// fingerprint(newSignPub)) so the human can cross-check the two screens. An attacker who
				// saw the QR and joined first then shows a different code and is caught. The owner key
				// (signPub) is NOT shown here; it is only the unseal pin.
				sas = Crypto.fingerprint(repo.federation.consoleIdentity().sign.pub),
			)
		}.getOrNull()
	}

	/** NEW device: announce this device's freshly-generated console keys to the held device by POSTing a
	 * join to the public ingress (nonce-gated, no creds). consoleIdentity() mints+persists the keys on
	 * first call, so the keys sent here are the SAME ones this device later unseals with. */
	suspend fun newDeviceJoin(scan: ScannedDeviceApproval): Result<Unit> = withContext(Dispatchers.IO) {
		runCatching {
			val id = repo.federation.consoleIdentity()
			val op = ConsoleApprovalOp.Join(
				approvalId = scan.approvalId,
				nonce = scan.nonce,
				newSignPub = id.sign.pub,
				newBoxPub = id.box.pub,
				device = android.os.Build.MODEL,
			)
			val result = ConsoleHttp.postPublicApproval(scan.reach, op)
			if (!result.ok) error(result.error ?: "The held device didn't accept this join.")
			Unit
		}
	}

	/** NEW device: poll the public ingress for the held device's sealed reply. Returns true once it
	 * arrives - unseals it (verifying the owner signPub pinned from the QR) and installs the transport;
	 * false while still pending, so the caller keeps polling. */
	suspend fun newDeviceFetch(scan: ScannedDeviceApproval): Result<Boolean> = withContext(Dispatchers.IO) {
		runCatching {
			val op = ConsoleApprovalOp.Fetch(approvalId = scan.approvalId, nonce = scan.nonce)
			val result = ConsoleHttp.postPublicApproval(scan.reach, op)
			if (!result.ok) error(result.error ?: "The approval window expired.")
			val sealed = result.sealed ?: return@runCatching false
			val plain = repo.federation.unsealConsoleTransport(sealed, scan.ownerSignPub)
			val transport = wireJson.decodeFromString(ConsoleTransport.serializer(), plain.toString(Charsets.UTF_8))
			installApprovedDevice(transport)
			true
		}
	}

	/** NEW device: install the unsealed transport. Writes the provisioning blob through the EXISTING
	 * provisioning store write, adopts the owner's synced keyring + route Gateway, and marks this device
	 * admitted - the held device already owner-signed + submitted its admission, and this device holds
	 * no owner key, so it must NEVER self-sign. provisioned flips LAST so the poll loop starts only
	 * after consoleAdmitted is set, never racing a self-admission with a throwaway owner key. */
	private fun installApprovedDevice(transport: ConsoleTransport) {
		// Every transport field is restated: a rebuild that enumerates only the k8s ones drops a
		// direct record on the way in, and the new device silently provisions against nothing.
		val prov = com.atelier_nyaarium.switchboard.proto.Provisioning(
			transport = transport.transport,
			apiUrl = transport.apiUrl.ifEmpty { null },
			caPem = transport.caPem.ifEmpty { null },
			saToken = transport.saToken.ifEmpty { null },
			routerUrl = transport.routerUrl.ifEmpty { null },
			routerCertFp = transport.routerCertFp.ifEmpty { null },
			appToken = transport.appToken,
			namespace = transport.namespace,
			service = transport.service,
			port = transport.port,
		)
		val blob = wireJson.encodeToString(com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(), prov)
		repo.store.save(blob)
		repo.store.consoleAdmitted = true
		repo.store.firstRooted = true
		repo.store.enrollCeremonyDone = true
		transport.domain?.let { snap ->
			repo.store.saveDomain(
				wireJson.encodeToString(com.atelier_nyaarium.switchboard.proto.DomainSnapshot.serializer(), snap),
				transport.domainVersion ?: "",
			)
		}
		transport.gatewayId?.takeIf { it.isNotEmpty() }?.let {
			repo.store.saveGatewayId(it)
			repo.localGatewayId = it
		}
		// This is the ONE path besides a real first-root that sets firstRooted=true - it never
		// calls evie's first-root intake (the held device already rooted), so trace the latch
		// origin explicitly or a stuck-latch investigation cannot tell the two apart.
		DebugLog.log(
			"AddDevice",
			"installed approved-device transport; consoleAdmitted+firstRooted set, " +
				"keyring=${if (transport.domain != null) "adopted" else "absent"} gateway=${transport.gatewayId ?: "none"}",
		)
		repo.client = null
		repo.sttsClient = null
		val parsed = Provisioning.parse(blob)
		repo._state.update { it.copy(provisioned = true, error = null, deviceName = parsed.device, firstRooted = true) }
	}
}
