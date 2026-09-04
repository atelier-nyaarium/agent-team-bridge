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

internal fun verifyDeviceJoin(approvalId: String, nonce: String, join: ConsoleApprovalJoin): Boolean {
	val signature = join.joinSig ?: return false
	return runCatching {
		Crypto.verify(
			Crypto.deviceJoinSigningBytes(approvalId, nonce, join.newSignPub, join.newBoxPub),
			signature,
			join.newSignPub,
		)
	}.getOrDefault(false)
}

/** The "Add a device" surface: a held device arms a one-time approval window and a fresh device
 * joins it, all keyed off the console-approval broker (no admin round trip). */
internal class DeviceApprovalOps(private val repo: ChatRepository) {
	private val approvalNonces = mutableMapOf<String, String>()
	////////////////////////////////
	//  Add a device (USER self-enroll: the owner authorizes their OWN fresh device, no admin)

	/** The Router's public device-approval reach for the authorize-console QR, or null when this network
	 * has no public ingress (the Add-a-device entry is then shown disabled). */
	fun deviceApprovalReach(): String? =
		runCatching { repo.store.load()?.let { Provisioning.parse(it, repo.store) } }.getOrNull()?.deviceApprovalReach?.takeIf { it.isNotEmpty() }

	/** The Router cert fingerprint to pin the reach against, empty when this device holds none. */
	private fun routerCertFp(): String =
		runCatching { repo.store.load()?.let { Provisioning.parse(it, repo.store) } }.getOrNull()?.routerCertFp ?: ""

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
			require(verifyDeviceJoin(approvalId, nonce, join)) {
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
			require(verifyDeviceJoin(approvalId, nonce, join)) {
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
		val prov = Provisioning.parse(repo.store.load() ?: error("not provisioned"), repo.store)
		val console = repo.federation.consoleIdentity()
		val domainId = repo.confirmedDomainId() ?: error("Your Domain isn't confirmed yet - open a session first.")
		repo.federation.ensureContentEpochs(domainId)
		return ConsoleTransport(
			routerUrl = prov.routerUrl,
			routerCertFp = prov.routerCertFp,
			appToken = prov.appToken,
			domainId = domainId,
			gatewayId = repo.homeGatewayId.takeIf { it.isNotEmpty() } ?: repo.store.loadGatewayId().takeIf { it.isNotEmpty() },
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

	/** Install approved transport without self-signing. Mark provisioned last. */
	private fun installApprovedDevice(transport: ConsoleTransport) {
		val contentMerge = classifyContentKeys(transport)
		val contentKeys = when (contentMerge) {
			is ContentKeyring.Merge.Refused -> {
				repo._state.update { it.copy(error = "content key installation refused", provisioned = false) }
				error("content key installation refused")
			}
			ContentKeyring.Merge.Unchanged -> heldContentKeys()
			is ContentKeyring.Merge.Installed -> contentMerge.next
		}
		// Every transport field is restated: a rebuild that enumerates a subset drops a record on the
		// way in, and the new device silently provisions against nothing.
		val prov = com.atelier_nyaarium.switchboard.proto.Provisioning(
			routerUrl = transport.routerUrl.ifEmpty { null },
			routerCertFp = transport.routerCertFp.ifEmpty { null },
			appToken = transport.appToken,
		)
		val blob = wireJson.encodeToString(com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(), prov)
		val domainJson = transport.domain?.let {
			wireJson.encodeToString(com.atelier_nyaarium.switchboard.proto.DomainSnapshot.serializer(), it)
		}
		val gatewayId = transport.gatewayId?.takeIf { it.isNotEmpty() }
		check(repo.store.installApprovedDevice(blob, domainJson, transport.domainVersion, gatewayId, contentKeys)) {
			"approved-device install could not be committed"
		}
		gatewayId?.let { repo.homeGatewayId = it }
		repo.client = null
		repo.sttsClient = null
		// Refresh after route assignment.
		if (transport.domain != null) repo.refreshAdmittedGateways()
		// Preserve first-root provenance.
		DebugLog.log(
			"AddDevice",
			"installed approved-device transport; consoleAdmitted+firstRooted set, " +
				"keyring=${if (transport.domain != null) "adopted" else "absent"} gateway=${transport.gatewayId ?: "none"}",
		)
		val parsed = Provisioning.parse(blob, repo.store)
		repo._state.update { it.copy(provisioned = true, error = null, deviceName = parsed.device, firstRooted = true) }
	}

	private fun classifyContentKeys(transport: ConsoleTransport): ContentKeyring.Merge {
		val keyring = transport.domain?.let(::Keyring) ?: repo.federation.keyring()
		return ContentKeyring(repo.federation.consoleIdentity().box.priv, repo.store).classify(transport.contentKeys, keyring)
	}

	private fun heldContentKeys(): Map<Int, ByteArray> =
		when (val load = repo.store.loadContentKeys()) {
			is ContentKeysLoad.Loaded -> load.keys
			ContentKeysLoad.Absent -> emptyMap()
			is ContentKeysLoad.Corrupt -> error("content key slot is corrupt")
		}
}
