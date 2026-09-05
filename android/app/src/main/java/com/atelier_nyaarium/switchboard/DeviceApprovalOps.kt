package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalJoin
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.Provisioning
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal interface DeviceApprovalOpsCollaborators {
	fun approvalNonces(): MutableMap<String, String>
	fun homeGatewayId(): String
	fun setHomeGatewayId(value: String)
	fun installApprovedDevice(
		blob: String,
		domainJson: String?,
		domainVersion: String?,
		gatewayId: String?,
		contentKeys: Map<Int, ByteArray>,
		domainId: String?,
	): Boolean
	fun invalidateClients()
	suspend fun submitOwnerAdmission(signed: SignedAdmission): Boolean
	fun refreshAdmittedGateways()
	fun reportError(): String?
}

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

internal class DeviceApprovalOps(
	private val state: MutableStateFlow<ChatState>,
	private val store: AppStateStore,
	private val identity: IdentityPort,
	private val client: ClientPort,
	private val collaborators: DeviceApprovalOpsCollaborators,
) {
	private val approvalNonces get() = collaborators.approvalNonces()

	fun deviceApprovalReach(): String? =
		runCatching { store.load()?.let { ConsoleCredentials.parse(it, store) } }.getOrNull()?.deviceApprovalReach?.takeIf { it.isNotEmpty() }

	private fun routerCertFp(): String =
		runCatching { store.load()?.let { ConsoleCredentials.parse(it, store) } }.getOrNull()?.routerCertFp ?: ""

	suspend fun armDeviceApproval(): Result<DeviceApprovalArmed> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val reach = deviceApprovalReach() ?: error("This network has no device-approval reach configured.")
			val boot = identity.readyOrNull() ?: error("Your Domain isn't confirmed yet - open a session first.")
			val domainId = boot.domainId
			val approvalId = identity.federation.freshApprovalToken()
			val nonce = identity.federation.freshApprovalToken()
			val result = client.client().postConsoleApproval(ConsoleApprovalOp.Arm(approvalId = approvalId, nonce = nonce))
			if (!result.ok) error(result.error ?: "Couldn't arm the approval window.")
			approvalNonces[approvalId] = nonce
			// QR contains public enrollment data, never an SA token.
			val qr = JSONObject()
				.put("type", "authorize-console")
				.put("domainId", domainId)
				.put("signPub", boot.ownerSignPub)
				.put("boxPub", identity.federation.ownerBoxPub())
				.put("approvalId", approvalId)
				.put("nonce", nonce)
				.put("reach", reach)
				.put("reachCertFp", routerCertFp())
				.toString()
			DeviceApprovalArmed(approvalId, nonce, qr)
		}
	}

	suspend fun pollDeviceApproval(approvalId: String): Result<ConsoleApprovalJoin?> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val result = client.client().postConsoleApproval(ConsoleApprovalOp.Poll(approvalId = approvalId))
			if (!result.ok) error(result.error ?: "approval window closed")
			val join = result.join ?: return@runCatchingCancellable null
			val nonce = approvalNonces[approvalId] ?: error("approval nonce unavailable")
			require(verifyDeviceJoin(approvalId, nonce, join)) {
				"device join signature is invalid"
			}
			join
		}
	}

	suspend fun approveDevice(approvalId: String, nonce: String, join: ConsoleApprovalJoin): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			require(verifyDeviceJoin(approvalId, nonce, join)) {
				"device join signature is invalid"
			}
			val transport = buildConsoleTransport(join.newBoxPub)
			val plain = wireJson.encodeToString(ConsoleTransport.serializer(), transport).toByteArray(Charsets.UTF_8)
			val sealed = identity.federation.sealConsoleTransport(join.newBoxPub, plain)
			val signed = identity.federation.admitConsole(join.newSignPub, join.newBoxPub, System.currentTimeMillis())
			if (!collaborators.submitOwnerAdmission(signed)) {
				error(collaborators.reportError() ?: "The server rejected the new device.")
			}
			val result = client.client().postConsoleApproval(ConsoleApprovalOp.Approve(approvalId = approvalId, sealed = sealed))
			if (!result.ok) error(result.error ?: "Couldn't deliver the sealed transport.")
			Unit
		}
	}

	suspend fun cancelDeviceApproval(approvalId: String) {
		withContext(Dispatchers.IO) {
			runCatchingCancellable { client.client().postConsoleApproval(ConsoleApprovalOp.Cancel(approvalId = approvalId)) }
		}
	}

	private fun buildConsoleTransport(recipientBoxPub: String): ConsoleTransport {
		val boot = identity.readyOrNull() ?: error("Your Domain isn't confirmed yet - open a session first.")
		val prov = boot.credentials
		val console = boot.consoleIdentity
		val domainId = boot.domainId
		identity.ensureContentEpochs(boot)
		return ConsoleTransport(
			routerUrl = prov.routerUrl,
			routerCertFp = prov.routerCertFp,
			appToken = prov.appToken,
			domainId = domainId,
				gatewayId = collaborators.homeGatewayId().takeIf { it.isNotEmpty() } ?: store.loadGatewayId().takeIf { it.isNotEmpty() },
				domainVersion = store.loadDomainVersion().ifEmpty { null },
			domain = boot.keyring().snapshot,
			contentKeys = boot.contentKeyring.wrapAllFor(
				recipientBoxPub,
				console.sign.pub,
				console.sign.priv,
			),
		)
	}

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
				// Display the joining console fingerprint for human comparison.
				sas = Crypto.fingerprint(identity.federation.consoleIdentity().sign.pub),
			)
		}.getOrNull()
	}

	suspend fun newDeviceJoin(scan: ScannedDeviceApproval): Result<Unit> = withContext(Dispatchers.IO) {
		runCatching {
			val id = identity.federation.consoleIdentity()
			// These keys are reused when the new device unwraps transport.
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

	suspend fun newDeviceFetch(scan: ScannedDeviceApproval): Result<Boolean> = withContext(Dispatchers.IO) {
		runCatching {
			val op = ConsoleApprovalOp.Fetch(approvalId = scan.approvalId, nonce = scan.nonce)
			val result = ConsoleHttp.postPublicApproval(scan.reach, op)
			if (!result.ok) error(result.error ?: "The approval window expired.")
			val sealed = result.sealed ?: return@runCatching false
			// The QR owner key authenticates the sealed transport.
			val plain = identity.federation.unsealConsoleTransport(sealed, scan.ownerSignPub)
			val transport = wireJson.decodeFromString(ConsoleTransport.serializer(), plain.toString(Charsets.UTF_8))
			installApprovedDevice(transport)
			true
		}
	}

	private fun installApprovedDevice(transport: ConsoleTransport) {
		val contentMerge = classifyContentKeys(transport)
		val contentKeys = when (contentMerge) {
			is ContentKeyring.Merge.Refused -> {
				state.update { it.copy(error = "content key installation refused", provisioned = false) }
				error("content key installation refused")
			}
			ContentKeyring.Merge.Unchanged -> heldContentKeys()
			is ContentKeyring.Merge.Installed -> contentMerge.next
		}
		// Rebuild every transport field to preserve the approved record.
		val prov = Provisioning(
			routerUrl = transport.routerUrl.ifEmpty { null },
			routerCertFp = transport.routerCertFp.ifEmpty { null },
			appToken = transport.appToken,
		)
		val blob = wireJson.encodeToString(Provisioning.serializer(), prov)
		val domainJson = transport.domain?.let {
			wireJson.encodeToString(com.atelier_nyaarium.switchboard.proto.DomainSnapshot.serializer(), it)
		}
		val gatewayId = transport.gatewayId?.takeIf { it.isNotEmpty() }
		check(collaborators.installApprovedDevice(blob, domainJson, transport.domainVersion, gatewayId, contentKeys, transport.domainId)) {
			"approved-device install could not be committed"
		}
		gatewayId?.let { collaborators.setHomeGatewayId(it) }
		collaborators.invalidateClients()
		if (transport.domain != null) collaborators.refreshAdmittedGateways()
		DebugLog.log(
			"AddDevice",
			"installed approved-device transport; consoleAdmitted+firstRooted set, " +
				"keyring=${if (transport.domain != null) "adopted" else "absent"} gateway=${transport.gatewayId ?: "none"}",
		)
		val parsed = ConsoleCredentials.parse(blob, store)
		state.update { it.copy(provisioned = true, error = null, deviceName = parsed.device, firstRooted = true) }
	}

	private fun classifyContentKeys(transport: ConsoleTransport): ContentKeyring.Merge {
		val keyring = transport.domain?.let(::Keyring) ?: identity.federation.keyring()
		return ContentKeyring(identity.federation.consoleIdentity().box.priv, store).classify(transport.contentKeys, keyring)
	}

	private fun heldContentKeys(): Map<Int, ByteArray> =
		when (val load = store.loadContentKeys()) {
			is ContentKeysLoad.Loaded -> load.keys
			ContentKeysLoad.Absent -> emptyMap()
			is ContentKeysLoad.Corrupt -> error("content key slot is corrupt")
		}
}
