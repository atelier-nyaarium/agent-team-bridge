package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.KeyEnvelope
import com.atelier_nyaarium.switchboard.proto.KeyGrant
import com.atelier_nyaarium.switchboard.proto.KeyGrantOp
import com.atelier_nyaarium.switchboard.proto.KeyReceipt
import com.atelier_nyaarium.switchboard.proto.KeyReceiptOp
import com.atelier_nyaarium.switchboard.proto.KeyReceiptsReadOp
import com.atelier_nyaarium.switchboard.proto.KeyReceiptsReadResult
import com.atelier_nyaarium.switchboard.proto.KeyRequestOp
import com.atelier_nyaarium.switchboard.proto.KeyRequest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject

data class KeyDeliveryInstall(val accepted: Boolean, val committed: Boolean, val reason: String? = null)

data class KeyDeliveryMember(val kind: String, val signPub: String, val epoch: Int, val confirmed: Boolean)

interface MissingEpochTimer {
	fun schedule(delayMs: Long, task: suspend () -> Unit)
}

internal class KeyDeliveryCollaborators(
	val signOwnerOp: (JsonObject) -> com.atelier_nyaarium.switchboard.proto.OwnerOp?,
	val sendOwnerOp: suspend (com.atelier_nyaarium.switchboard.proto.OwnerOp) -> JsonElement?,
	val install: (KeyEnvelope, Keyring) -> KeyDeliveryInstall,
	val reportError: (String) -> Unit,
)

internal class KeyDeliveryOps(
	private val boot: PhoneBootstrap,
	private val ambient: PhoneAmbient,
	private val collaborators: KeyDeliveryCollaborators,
) {
	companion object {
		private const val MISSING_RETRY_MS = 10 * 60 * 1000L
		private const val MISSING_WINDOW_MS = 24 * 60 * 60 * 1000L
		private const val KEY_GRANT_WINDOW_MS = MISSING_RETRY_MS
		private const val MAX_RECENT_GRANTS = 4096
		private const val UNRECORDED_GRANT = -1L
	}

	private data class GrantKey(val subject: String, val epoch: Int)
	private data class GrantClaim(val at: Long, val token: Long)

	private val missing = linkedMapOf<Int, Long>()
	private val recentGrants = linkedMapOf<GrantKey, GrantClaim>()
	private var nextGrantToken = 0L
	private var missingFlushScheduled = false
	private var missingRetryScheduled = false
	private var missingLastSentAt = 0L

	fun requestMissing(epoch: Int) {
		if (epoch < 1) return
		synchronized(missing) {
			if (missing.containsKey(epoch)) return
			missing[epoch] = ambient.now()
			if (!missingFlushScheduled) {
				missingFlushScheduled = true
				ambient.missingTimer.schedule(0) { flushMissing() }
			}
		}
	}
	suspend fun onKeyRequest(request: KeyRequest) {
		val domain = boot.domainId
		if (request.domainId != domain) return
		if (!Crypto.verify(
			Crypto.keyRequestSigningBytes(domain, request.requesterSignPub, request.epochs, request.at, request.nonce),
			request.signature,
			request.requesterSignPub,
		)) return
		val recipient = boot.keyring().resolveSubject(request.requesterSignPub)
		// An unknown requester is dropped silently otherwise.
		if (recipient == null) {
			DebugLog.log("KeyDelivery", "request from unknown subject ${request.requesterSignPub.take(8)}")
			return
		}
		val identity = boot.consoleIdentity
		val ring = boot.contentKeyring
		val epochs = request.epochs.filter { it >= 1 && it <= Int.MAX_VALUE.toLong() }.map { it.toInt() }
		var granted = 0
		var skipped = 0
		val envelopes = ring.wrapFor(epochs, recipient.boxPub, identity.sign.pub, identity.sign.priv, entropy = ambient.wrapEntropy)
		for (envelope in envelopes) {
			val grantKey = GrantKey(recipient.signPub, envelope.epoch.toInt())
			val claimToken = claimGrant(grantKey) ?: run {
				skipped++
				continue
			}
			try {
				if (send(grantOp(KeyGrant(1, recipient.signPub, envelope, ambient.now()))) != null) granted++ else releaseGrant(grantKey, claimToken)
			} catch (e: Exception) {
				try {
					e.rethrowIfCancellation()
				} finally {
					releaseGrant(grantKey, claimToken)
				}
			}
		}
		DebugLog.log("KeyDelivery", "granted $granted of ${epochs.size} to ${request.requesterSignPub.take(8)} skipped $skipped")
	}

	/** Null means already claimed; UNRECORDED_GRANT means grant it but the map was full. */
	private fun claimGrant(key: GrantKey): Long? {
		val current = ambient.now()
		synchronized(recentGrants) {
			recentGrants.entries.removeIf { current - it.value.at >= KEY_GRANT_WINDOW_MS }
			if (recentGrants.containsKey(key)) return null
			// Evicting a live claim would re-grant the pair it belonged to, so a full map forgoes the claim.
			if (recentGrants.size >= MAX_RECENT_GRANTS) return UNRECORDED_GRANT
			nextGrantToken++
			recentGrants[key] = GrantClaim(current, nextGrantToken)
			return nextGrantToken
		}
	}

	private fun releaseGrant(key: GrantKey, token: Long) {
		if (token == UNRECORDED_GRANT) return
		synchronized(recentGrants) {
			if (recentGrants[key]?.token == token) recentGrants.remove(key)
		}
	}

	suspend fun onKeyGrant(grant: KeyGrant) {
		val identity = boot.consoleIdentity
		if (grant.recipientSignPub != identity.sign.pub) return
		val result = collaborators.install(grant.envelope, boot.keyring())
		if (result.accepted && result.committed) {
			if (grant.envelope.epoch >= 1 && grant.envelope.epoch <= Int.MAX_VALUE.toLong()) {
				synchronized(missing) { missing.remove(grant.envelope.epoch.toInt()) }
			}
			val domain = boot.domainId
			val at = ambient.now()
			val nonce = ambient.newNonce()
			val receipt = KeyReceipt(
				1,
				domain,
				identity.sign.pub,
				grant.envelope.epoch,
				at,
				nonce,
				Crypto.sign(Crypto.keyReceiptSigningBytes(domain, identity.sign.pub, grant.envelope.epoch, at, nonce), identity.sign.priv),
			)
			send(receiptOp(receipt))
			DebugLog.log("KeyDelivery", "grant installed epoch=${grant.envelope.epoch}")
		} else if (!result.accepted) {
			DebugLog.log("KeyDelivery", "grant refused reason=${result.reason ?: "unknown"}")
		}
	}

	suspend fun redeliverAll(): List<KeyDeliveryMember> {
		val identity = boot.consoleIdentity
		val epochs = boot.contentKeyring.epochs()
		val members = boot.keyring().liveAdmissions().filter { it.signPub != identity.sign.pub }
		for (member in members) {
			val envelopes =
				boot.contentKeyring.wrapFor(epochs, member.boxPub, identity.sign.pub, identity.sign.priv, entropy = ambient.wrapEntropy)
			for (envelope in envelopes) {
				send(grantOp(KeyGrant(1, member.signPub, envelope, ambient.now())))
			}
		}
		val answer = send(keyReceiptsReadOp()) ?: return members.flatMap { member -> epochs.map { KeyDeliveryMember(member.kind, member.signPub, it, false) } }
		val receipts = runCatching {
			val body = wireJson.decodeFromJsonElement(OwnerOpAnswer.serializer(), answer)
			wireJson.decodeFromJsonElement(KeyReceiptsReadResult.serializer(), body.result ?: return@runCatching null)
		}.getOrElse {
			runCatching { wireJson.decodeFromJsonElement(KeyReceiptsReadResult.serializer(), answer) }.getOrNull()
		}?.receipts.orEmpty()
		return members.flatMap { member -> epochs.map { epoch ->
			KeyDeliveryMember(member.kind, member.signPub, epoch, receipts.any { it.recipientSignPub == member.signPub && it.epoch.toInt() == epoch })
		} }
	}

	private suspend fun flushMissing() {
		val epochs = synchronized(missing) {
			missingFlushScheduled = false
			missing.keys.toList()
		}
		if (epochs.isNotEmpty()) {
			sendMissing(epochs)
			synchronized(missing) { missingLastSentAt = ambient.now() }
		}
		scheduleMissingRetry()
	}

	// Retry from last send. Expire from first request.
	private suspend fun retryMissing() {
		val current = ambient.now()
		val due = synchronized(missing) {
			val expired = missing.filterValues { current - it >= MISSING_WINDOW_MS }.keys.toList()
			expired.forEach { missing.remove(it); collaborators.reportError("Content key epoch $it remains unavailable") }
			if (current - missingLastSentAt >= MISSING_RETRY_MS) missing.keys.toList() else emptyList()
		}
		if (due.isNotEmpty()) {
			sendMissing(due)
			synchronized(missing) { missingLastSentAt = current }
		}
		scheduleMissingRetry()
	}

	private fun scheduleMissingRetry() {
		synchronized(missing) {
			if (missing.isEmpty() || missingRetryScheduled) return
			missingRetryScheduled = true
			val current = ambient.now()
			val untilExpiry = missing.values.minOf { first -> MISSING_WINDOW_MS - (current - first) }
			val delayMs = minOf(MISSING_RETRY_MS - (current - missingLastSentAt), untilExpiry).coerceAtLeast(1)
			ambient.missingTimer.schedule(delayMs) {
				synchronized(missing) { missingRetryScheduled = false }
				retryMissing()
			}
		}
	}

	private suspend fun sendMissing(epochs: List<Int>) {
		val domain = boot.domainId
		val identity = boot.consoleIdentity
		val at = ambient.now()
		val nonce = ambient.newNonce()
		val request = KeyRequest(
			1,
			domain,
			identity.sign.pub,
			epochs.map { it.toLong() },
			at,
			nonce,
			Crypto.sign(Crypto.keyRequestSigningBytes(domain, identity.sign.pub, epochs.map { it.toLong() }, at, nonce), identity.sign.priv),
		)
		send(wireJson.encodeToJsonElement(KeyRequestOp.serializer(), KeyRequestOp(request = request)).jsonObject)
	}

	private suspend fun send(op: JsonObject): JsonElement? {
		val signed = collaborators.signOwnerOp(op) ?: return null
		return collaborators.sendOwnerOp(signed)
	}

	private fun grantOp(grant: KeyGrant): JsonObject =
		wireJson.encodeToJsonElement(KeyGrantOp.serializer(), KeyGrantOp(grant = grant)).jsonObject

	private fun receiptOp(receipt: KeyReceipt): JsonObject =
		wireJson.encodeToJsonElement(KeyReceiptOp.serializer(), KeyReceiptOp(receipt = receipt)).jsonObject

	private fun keyReceiptsReadOp(): JsonObject =
		wireJson.encodeToJsonElement(KeyReceiptsReadOp.serializer(), KeyReceiptsReadOp()).jsonObject

}
