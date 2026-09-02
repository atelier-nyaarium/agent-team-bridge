package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Keyring
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
	private val approvalNonces = mutableMapOf<String, String>()
	////////////////////////////////
	//  Add a device (USER self-enroll: the owner authorizes their OWN fresh device, no admin)

	/** The Router's public device-approval reach for the authorize-console QR, or null when this network
	 * has no public ingress (the Add-a-device entry is then shown disabled). */
	fun deviceApprovalReach(): String? =
		runCatching { repo.store.load()?.let { Provisioning.parse(it) } }.getOrNull()?.deviceApprovalReach?.takeIf { it.isNotEmpty() }

	/** The Router cert fingerprint to pin the reach against, empty when this device holds none. */
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
			approvalNonces[approvalId] = nonce
			val qr = JSONObject()
				.put("type", "authorize-console")
				.put("domainId", domainId)
				.put("signPub", repo.federation.ownerSignPub())
				.put("boxPub", repo.federation.ownerBoxPub())
				.put("approvalId", approvalId)
				.put("nonce", nonce)
				.put("reach", reach)
				// A fresh device holds no provisioning record, so the QR is the only place it can
				// learn which cert to pin against a self-signed Router.
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
			val join = result.join ?: return@runCatchingCancellable null
			val nonce = approvalNonces[approvalId] ?: error("approval nonce unavailable")
			require(
				join.joinSig != null && Crypto.verify(
					Crypto.deviceJoinSigningBytes(approvalId, nonce, join.newSignPub, join.newBoxPub),
					join.joinSig!!,
					join.newSignPub,
				),
			) {
				"device join signature is invalid"
			}
			join
		}
	}

	/** HELD device: approve the joined device. Owner-signs a kind:console admission for its keys and
	 * submits it (the existing submit_admission path), then seals the console transport to its box key
	 * and parks it for the device to fetch. The biometric gate is applied at the UI call site. */
	suspend fun approveDevice(approvalId: String, nonce: String, join: ConsoleApprovalJoin): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			require(
				join.joinSig != null && Crypto.verify(
					Crypto.deviceJoinSigningBytes(approvalId, nonce, join.newSignPub, join.newBoxPub),
					join.joinSig!!,
					join.newSignPub,
				),
			) {
				"device join signature is invalid"
			}
			val transport = buildConsoleTransport(join.newBoxPub)
			val plain = wireJson.encodeToString(ConsoleTransport.serializer(), transport).toByteArray(Charsets.UTF_8)
			val sealed = repo.federation.sealConsoleTransport(join.newBoxPub, plain)
			val signed = repo.federation.admitConsole(join.newSignPub, join.newBoxPub, System.currentTimeMillis())
			if (!repo.ownerFacts.submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitAdmission(it)) }, repo.federation::mergeAdmission, "Approve failed")) {
				error(repo._state.value.error ?: "The server rejected the new device.")
			}
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

	/** Transport for an approved device. */
	private fun buildConsoleTransport(recipientBoxPub: String): ConsoleTransport {
		val prov = Provisioning.parse(repo.store.load() ?: error("not provisioned"))
		val console = repo.federation.consoleIdentity()
		val domainId = repo.confirmedDomainId() ?: error("Your Domain isn't confirmed yet - open a session first.")
		repo.federation.ensureContentEpochs(domainId)
		return ConsoleTransport(
			routerUrl = prov.routerUrl,
			routerCertFp = prov.routerCertFp,
			appToken = prov.appToken,
			domainId = domainId,
			gatewayId = repo.localGatewayId.takeIf { it.isNotEmpty() } ?: repo.store.loadGatewayId().takeIf { it.isNotEmpty() },
			domainVersion = repo.store.loadDomainVersion().ifEmpty { null },
			domain = repo.federation.keyring().snapshot,
			contentKeys = ContentKeyring(store = repo.store).wrapAllFor(
				recipientBoxPub,
				console.sign.pub,
				console.sign.priv,
			),
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
			val joinSig = Crypto.sign(
				Crypto.deviceJoinSigningBytes(scan.approvalId, scan.nonce, id.sign.pub, id.box.pub),
				id.sign.priv,
			)
			val op = ConsoleApprovalOp.Join(
				approvalId = scan.approvalId,
				nonce = scan.nonce,
				newSignPub = id.sign.pub,
				newBoxPub = id.box.pub,
				joinSig = joinSig,
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
		if (!installContentKeys(transport)) {
			repo._state.update { it.copy(error = "content key installation refused", provisioned = false) }
			error("content key installation refused")
		}
		// Every transport field is restated: a rebuild that enumerates a subset drops a record on the
		// way in, and the new device silently provisions against nothing.
		val prov = com.atelier_nyaarium.switchboard.proto.Provisioning(
			routerUrl = transport.routerUrl.ifEmpty { null },
			routerCertFp = transport.routerCertFp.ifEmpty { null },
			appToken = transport.appToken,
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
		// The one keyring write that is not a fold, so nothing else would publish the machines this
		// device just adopted until a connect succeeds. AFTER the route id above: the board names a
		// machine relative to the route Gateway, so refreshing first publishes a roster read against
		// the id this device is replacing.
		if (transport.domain != null) repo.refreshAdmittedGateways()
		// This is the ONE path besides a real first-root that sets firstRooted=true - it never
		// calls the Router's first-root intake (the held device already rooted), so trace the latch
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

	private fun installContentKeys(transport: ConsoleTransport): Boolean {
		val domain = transport.domain ?: return transport.contentKeys.isEmpty()
		val keyring = Keyring(domain)
		val contentKeyring = ContentKeyring(repo.federation.consoleIdentity().box.priv, repo.store)
		val classified = contentKeyring.classify(transport.contentKeys, keyring) ?: return false
		contentKeyring.commit(classified)
		return true
	}
}
