package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeOp
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeRef
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.PendingTenantRef
import com.atelier_nyaarium.switchboard.proto.Provisioning
import com.atelier_nyaarium.switchboard.proto.RosterRequest
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import com.atelier_nyaarium.switchboard.proto.SignedFirstRoot
import com.atelier_nyaarium.switchboard.proto.TransportRequest
import com.atelier_nyaarium.switchboard.proto.TrustHandshakeOp
import com.atelier_nyaarium.switchboard.proto.TrustPendingRequest
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

data class ConsoleCredentials(
	val routerUrl: String,
	val routerCertFp: String,
	val appToken: String,
	val device: String,
	val conversationId: String,
	val pendingTenant: PendingTenantRef?,
	val enrollHandshake: EnrollHandshakeRef?,
	val deviceApprovalReach: String?,
) {
	companion object {
		private val DEVICE_DISALLOWED = Regex("[/\\r\\n]")

		fun parse(blob: String, store: AppStateStore): ConsoleCredentials {
			val wire = wireJson.decodeFromString<Provisioning>(blob)
			return ConsoleCredentials(
				routerUrl = wire.routerUrl?.trimEnd('/') ?: "",
				routerCertFp = wire.routerCertFp ?: "",
				appToken = wire.appToken ?: "",
				device = deviceNameOf(wire.device),
				conversationId = conversationIdFor(wire, store),
				pendingTenant = wire.pendingTenant,
				enrollHandshake = wire.enrollHandshake,
				deviceApprovalReach = wire.deviceApprovalReach?.trimEnd('/'),
			)
		}

		internal fun conversationIdFor(wire: Provisioning, store: AppStateStore): String {
			// The credential and Domain identify the console across transport changes.
			wire.conversationId?.let { return it }
			val stored = store.load()?.let { runCatching { wireJson.decodeFromString<Provisioning>(it) }.getOrNull() }
			val sameConsole = stored != null && stored.appToken == wire.appToken && stored.pendingTenant == wire.pendingTenant
			return (if (sameConsole) store.loadConversationId() else null) ?: UUID.randomUUID().toString()
		}

		private fun deviceNameOf(declared: String?): String =
			(declared ?: (android.os.Build.MODEL ?: "android"))
				.replace(DEVICE_DISALLOWED, "-")
				.take(64)
				.ifEmpty { "android" }
	}
}

data class SendResult(val ok: Boolean, val status: String, val error: String?)

@Serializable
internal data class EnrollEnvelope(
	val device: String,
	val conversationId: String,
	val opId: String,
	val enrollOp: EnrollOp,
)

@Serializable
// Internal for inline function visibility.
internal data class BounceBody(val error: String? = null, val retryable: Boolean = false)

@Serializable
internal data class FirstRootEnvelope(val firstRoot: SignedFirstRoot)

@Serializable
internal data class EnrollHandshakeEnvelope(val enrollHandshake: EnrollHandshakeOp)

@Serializable
internal data class RosterEnvelope(val roster: RosterRequest)

@Serializable
internal data class TransportEnvelope(val transport: TransportRequest)

@Serializable
internal data class ConsoleApprovalEnvelope(val consoleApproval: ConsoleApprovalOp)

@Serializable
internal data class TrustHandshakeEnvelope(val trustHandshake: TrustHandshakeOp)

@Serializable
internal data class TrustPendingEnvelope(val trustPending: TrustPendingRequest)

@Serializable
data class ProvisionTenantResult(val ok: Boolean, val error: String? = null, val nonce: String? = null)

// Unknown fields are tolerated for additive protocol changes.
internal val wireJson = Json { ignoreUnknownKeys = true }

const val BOARD_REFUSED_PREFIX = "refused:"

/** A refusal retires the queued action; other failures retry. */
class BoardRefused(val reason: String) : Exception(reason)

internal fun Crypto.SealedEnvelope.toProto(): SealedEnvelope =
	SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)

internal fun SealedEnvelope.toCrypto(): Crypto.SealedEnvelope =
	Crypto.SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)
