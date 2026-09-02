package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.ContentKeysLoad
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.proto.KeyEnvelope

class ContentKeyring(private val recipientBoxPrivB64: String = "", private val store: AppStateStore? = null) {
	private val load = store?.loadContentKeys() ?: ContentKeysLoad.Loaded(emptyMap())
	private val keys =
		(load as? ContentKeysLoad.Loaded)?.keys?.mapValues { it.value.copyOf() }?.toMutableMap() ?: mutableMapOf()
	sealed interface InstallOutcome {
		data object Installed : InstallOutcome
		data object AlreadyPresent : InstallOutcome
		data object Refused : InstallOutcome
	}

	fun ensureOwnerEpochs(ownerIdentity: Crypto.Identity, domainId: String) {
		if (load is ContentKeysLoad.Corrupt) {
			store?.saveContentKeysCorrupt(load.raw)
			DebugLog.log("ContentKeys", "corrupt content key slot preserved")
		}
		val highestVerifiedEpoch = keys.filter { (epoch, key) ->
			key.contentEquals(Crypto.deriveContentKey(ownerIdentity.sign.priv, domainId, epoch))
		}.keys.maxOrNull() ?: 0
		val mismatch = keys.any { (epoch, key) ->
			!key.contentEquals(Crypto.deriveContentKey(ownerIdentity.sign.priv, domainId, epoch))
		}
		if (mismatch) {
			store?.saveContentKeysCorrupt(keys)
			DebugLog.log("ContentKeys", "content key slot mismatch preserved")
			keys.clear()
		}
		if (keys.isEmpty()) deriveOwned(ownerIdentity, domainId, maxOf(1, highestVerifiedEpoch))
	}

	fun deriveOwned(ownerIdentity: Crypto.Identity, domainId: String, upToEpoch: Int) {
		require(upToEpoch >= 1) { "content epoch must be an integer from 1" }
		for (epoch in 1..upToEpoch) keys[epoch] = Crypto.deriveContentKey(ownerIdentity.sign.priv, domainId, epoch)
		persist()
	}

	fun install(envelope: KeyEnvelope, keyring: Keyring): InstallOutcome {
		val before = keys.toMap()
		val classified = classify(listOf(envelope), keyring) ?: return InstallOutcome.Refused
		val outcome = if (classified.size == before.size) InstallOutcome.AlreadyPresent else InstallOutcome.Installed
		if (outcome == InstallOutcome.Installed) commit(classified)
		return outcome
	}

	fun classify(envelopes: List<KeyEnvelope>, keyring: Keyring): Map<Int, ByteArray>? {
		check(load !is ContentKeysLoad.Corrupt) { "content key slot is corrupt" }
		val merged = keys.mapValues { it.value.copyOf() }.toMutableMap()
		for (envelope in envelopes) {
			if (keyring.resolveAdmittedConsole(envelope.signerSignPub) == null) return null
			val (epoch, key) = runCatching { Crypto.unwrapContentKey(envelope, recipientBoxPrivB64) }.getOrNull() ?: return null
			val held = merged[epoch]
			if (held != null && !held.contentEquals(key)) {
				DebugLog.log("ContentKeys", "content key mismatch epoch=$epoch")
				return null
			}
			merged.putIfAbsent(epoch, key.copyOf())
		}
		return merged
	}

	fun commit(keys: Map<Int, ByteArray>) {
		check(load !is ContentKeysLoad.Corrupt) { "content key slot is corrupt" }
		this.keys.clear()
		this.keys.putAll(keys.mapValues { it.value.copyOf() })
		persist()
	}

	fun keyFor(epoch: Int): ByteArray? = keys[epoch]?.copyOf()

	fun epochs(): List<Int> = keys.keys.sorted()

	fun wrapAllFor(recipientBoxPub: String, senderSignPub: String, senderSignPriv: String): List<KeyEnvelope> =
		check(load !is ContentKeysLoad.Corrupt) { "content key slot is corrupt" }.let {
		keys.keys.sorted().map { epoch ->
			Crypto.wrapContentKey(keys.getValue(epoch), epoch, recipientBoxPub, senderSignPub, senderSignPriv)
		}
		}

	private fun persist() {
		store?.saveContentKeys(keys)
	}
}
