package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.ContentKeysLoad
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.proto.KeyEnvelope

class ContentKeyring(private val recipientBoxPrivB64: String = "", private val store: AppStateStore? = null) {
	private val load = store?.loadContentKeys() ?: ContentKeysLoad.Loaded(emptyMap())
	private val keys =
		(load as? ContentKeysLoad.Loaded)?.keys?.mapValues { it.value.copyOf() }?.toMutableMap() ?: mutableMapOf()
	// Only the keyring can mint Installed.
	sealed interface Merge {
		data class Refused internal constructor(val reason: String) : Merge
		data object Unchanged : Merge
		data class Installed internal constructor(val next: Map<Int, ByteArray>, val epochs: List<Int>) : Merge
	}

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
		val next = keys.toMutableMap()
		for (epoch in 1..upToEpoch) next[epoch] = Crypto.deriveContentKey(ownerIdentity.sign.priv, domainId, epoch)
		commit(installed(next))
	}

	fun install(envelope: KeyEnvelope, keyring: Keyring): InstallOutcome {
		return when (val merge = classify(listOf(envelope), keyring)) {
			is Merge.Refused -> InstallOutcome.Refused
			Merge.Unchanged -> InstallOutcome.AlreadyPresent
			is Merge.Installed -> if (commit(merge)) InstallOutcome.Installed else InstallOutcome.Refused
		}
	}

	fun classify(envelopes: List<KeyEnvelope>, keyring: Keyring): Merge {
		if (load is ContentKeysLoad.Corrupt) return Merge.Refused("content key slot is corrupt")
		val merged = keys.mapValues { it.value.copyOf() }.toMutableMap()
		for (envelope in envelopes) {
			if (keyring.resolveAdmittedConsole(envelope.signerSignPub) == null) {
				return Merge.Refused("key signer is not an admitted console")
			}
			val (epoch, key) = runCatching { Crypto.unwrapContentKey(envelope, recipientBoxPrivB64) }.getOrNull()
				?: return Merge.Refused("content key envelope is invalid")
			val held = merged[epoch]
			if (held != null && !held.contentEquals(key)) {
				DebugLog.log("ContentKeys", "content key mismatch epoch=$epoch")
				return Merge.Refused("content key conflicts with the held epoch")
			}
			merged.putIfAbsent(epoch, key.copyOf())
		}
		return if (merged.keys == keys.keys) Merge.Unchanged else installed(merged)
	}

	fun commit(merge: Merge.Installed): Boolean {
		val next = merge.next.mapValues { it.value.copyOf() }
		val saved = store?.saveContentKeys(next) ?: true
		if (saved) {
			keys.clear()
			keys.putAll(next)
		}
		return saved
	}

	fun keyFor(epoch: Int): ByteArray? = keys[epoch]?.copyOf()

	fun epochs(): List<Int> = keys.keys.sorted()

	fun wrapAllFor(
		recipientBoxPub: String,
		senderSignPub: String,
		senderSignPriv: String,
		maxEpochs: Int? = null,
	): List<KeyEnvelope> =
		check(load !is ContentKeysLoad.Corrupt) { "content key slot is corrupt" }.let {
			keys.keys.sorted().takeLast(maxEpochs ?: Int.MAX_VALUE).map { epoch ->
				Crypto.wrapContentKey(keys.getValue(epoch), epoch, recipientBoxPub, senderSignPub, senderSignPriv)
			}
		}

	fun wrapFor(epochs: List<Int>, recipientBoxPub: String, senderSignPub: String, senderSignPriv: String): List<KeyEnvelope> =
		check(load !is ContentKeysLoad.Corrupt) { "content key slot is corrupt" }.let {
			epochs.distinct().filter { it in keys }.map { epoch ->
				Crypto.wrapContentKey(keys.getValue(epoch), epoch, recipientBoxPub, senderSignPub, senderSignPriv)
			}
		}

	private fun installed(next: Map<Int, ByteArray>): Merge.Installed =
		Merge.Installed(next.mapValues { it.value.copyOf() }, next.keys.sorted())
}
