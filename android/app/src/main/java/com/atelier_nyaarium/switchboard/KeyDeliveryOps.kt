package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
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
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject

data class KeyDeliveryInstall(val accepted: Boolean, val committed: Boolean, val reason: String? = null)

data class KeyDeliveryMember(val kind: String, val signPub: String, val epoch: Int, val confirmed: Boolean)

interface MissingEpochTimer {
	fun schedule(delayMs: Long, task: suspend () -> Unit)
}

private class CoroutineMissingEpochTimer : MissingEpochTimer {
	private val scope = CoroutineScope(Dispatchers.IO)

	override fun schedule(delayMs: Long, task: suspend () -> Unit) {
		scope.launch {
			if (delayMs > 0) delay(delayMs)
			task()
		}
	}
}

class KeyDeliveryOps(
	private val domainId: () -> String?,
	private val keyring: () -> Keyring,
	private val contentKeyring: () -> ContentKeyring,
	private val consoleIdentity: () -> Crypto.Identity,
	private val signOwnerOp: (JsonObject) -> com.atelier_nyaarium.switchboard.proto.OwnerOp?,
	private val sendOwnerOp: suspend (com.atelier_nyaarium.switchboard.proto.OwnerOp) -> JsonElement?,
	private val install: (KeyEnvelope, Keyring) -> KeyDeliveryInstall = { envelope, trust ->
		val ring = contentKeyring()
		when (val merge = ring.classify(listOf(envelope), trust)) {
			is ContentKeyring.Merge.Refused -> KeyDeliveryInstall(false, false, merge.reason)
			ContentKeyring.Merge.Unchanged -> KeyDeliveryInstall(true, true)
			is ContentKeyring.Merge.Installed ->
				if (ring.commit(merge)) KeyDeliveryInstall(true, true) else KeyDeliveryInstall(false, false, "content key commit failed")
		}
	},
	private val now: () -> Long = { System.currentTimeMillis() },
	private val newNonce: () -> String = { UUID.randomUUID().toString() },
	private val missingTimer: MissingEpochTimer = CoroutineMissingEpochTimer(),
	private val reportError: (String) -> Unit = {},
) {
	private val missing = linkedMapOf<Int, Long>()
	private var missingFlushScheduled = false
	private var missingRetryScheduled = false
	private var missingLastSentAt = 0L

	fun requestMissing(epoch: Int) {
		if (epoch < 1) return
		synchronized(missing) {
			if (missing.containsKey(epoch)) return
			missing[epoch] = now()
			if (!missingFlushScheduled) {
				missingFlushScheduled = true
				missingTimer.schedule(0) { flushMissing() }
			}
		}
	}
	suspend fun onKeyRequest(request: KeyRequest) {
		val domain = domainId() ?: return
		if (request.domainId != domain) return
		if (!Crypto.verify(
			Crypto.keyRequestSigningBytes(domain, request.requesterSignPub, request.epochs, request.at, request.nonce),
			request.signature,
			request.requesterSignPub,
		)) return
		val recipient = keyring().resolveSubject(request.requesterSignPub) ?: return
		val identity = consoleIdentity()
		val ring = contentKeyring()
		val epochs = request.epochs.filter { it >= 1 && it <= Int.MAX_VALUE.toLong() }.map { it.toInt() }
		for (envelope in ring.wrapFor(epochs, recipient.boxPub, identity.sign.pub, identity.sign.priv)) {
			send(grantOp(KeyGrant(1, recipient.signPub, envelope, now())))
		}
	}

	suspend fun onKeyGrant(grant: KeyGrant) {
		val identity = consoleIdentity()
		if (grant.recipientSignPub != identity.sign.pub) return
		val result = install(grant.envelope, keyring())
		if (result.accepted && result.committed) {
			if (grant.envelope.epoch >= 1 && grant.envelope.epoch <= Int.MAX_VALUE.toLong()) {
				synchronized(missing) { missing.remove(grant.envelope.epoch.toInt()) }
			}
			val domain = domainId() ?: return
			val at = now()
			val nonce = newNonce()
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
		} else if (!result.accepted) {
			DebugLog.log("KeyDelivery", "grant refused reason=${result.reason ?: "unknown"}")
		}
	}

	suspend fun redeliverAll(): List<KeyDeliveryMember> {
		domainId() ?: return emptyList()
		val identity = consoleIdentity()
		val epochs = contentKeyring().epochs()
		val members = keyring().liveAdmissions().filter { it.signPub != identity.sign.pub }
		for (member in members) {
			for (envelope in contentKeyring().wrapFor(epochs, member.boxPub, identity.sign.pub, identity.sign.priv)) {
				send(grantOp(KeyGrant(1, member.signPub, envelope, now())))
			}
		}
		val answer = send(keyReceiptsReadOp()) ?: return members.flatMap { member -> epochs.map { KeyDeliveryMember(member.kind, member.signPub, it, false) } }
		val receipts = runCatching {
			val body = wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.ConsoleReplyBody.serializer(), answer)
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
			synchronized(missing) { missingLastSentAt = now() }
		}
		scheduleMissingRetry()
	}

	// Retry from last send. Expire from first request.
	private suspend fun retryMissing() {
		val current = now()
		val due = synchronized(missing) {
			val expired = missing.filterValues { current - it >= MISSING_WINDOW_MS }.keys.toList()
			expired.forEach { missing.remove(it); reportError("Content key epoch $it remains unavailable") }
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
			val current = now()
			val untilExpiry = missing.values.minOf { first -> MISSING_WINDOW_MS - (current - first) }
			val delayMs = minOf(MISSING_RETRY_MS - (current - missingLastSentAt), untilExpiry).coerceAtLeast(1)
			missingTimer.schedule(delayMs) {
				synchronized(missing) { missingRetryScheduled = false }
				retryMissing()
			}
		}
	}

	private suspend fun sendMissing(epochs: List<Int>) {
		val domain = domainId() ?: return
		val identity = consoleIdentity()
		val at = now()
		val nonce = newNonce()
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
		val signed = signOwnerOp(op) ?: return null
		return sendOwnerOp(signed)
	}

	private fun grantOp(grant: KeyGrant): JsonObject =
		wireJson.encodeToJsonElement(KeyGrantOp.serializer(), KeyGrantOp(grant = grant)).jsonObject

	private fun receiptOp(receipt: KeyReceipt): JsonObject =
		wireJson.encodeToJsonElement(KeyReceiptOp.serializer(), KeyReceiptOp(receipt = receipt)).jsonObject

	private fun keyReceiptsReadOp(): JsonObject =
		wireJson.encodeToJsonElement(KeyReceiptsReadOp.serializer(), KeyReceiptsReadOp()).jsonObject

	private companion object {
		const val MISSING_RETRY_MS = 10 * 60 * 1000L
		const val MISSING_WINDOW_MS = 24 * 60 * 60 * 1000L
	}
}
