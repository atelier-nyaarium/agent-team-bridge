package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.PhoneAmbient
import com.atelier_nyaarium.switchboard.PhoneBootstrap
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.vaultAadKind
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope

/** Sole sealer and opener of vault fields on the phone. */
open class VaultSealing(
	private val boot: PhoneBootstrap,
	private val ambient: PhoneAmbient,
	private val onMissingEpoch: (Int) -> Unit,
) {
	val epochs: List<Int>
		get() = boot.contentKeyring.epochs()

	/** `id` is the entry id, or the request id for a typed value. */
	fun seal(text: String, kind: String, id: String): ContentEnvelope? {
		val epoch = boot.contentKeyring.epochs().maxOrNull() ?: return null
		val key = boot.contentKeyring.keyFor(epoch) ?: return null.also { onMissingEpoch(epoch) }
		return Crypto.sealContent(text.toByteArray(Charsets.UTF_8), key, aad(epoch, kind, id), ambient.newNonceBytes())
	}

	open fun open(env: ContentEnvelope, kind: String, id: String): String? {
		val epoch = env.epoch.toInt()
		val key = boot.contentKeyring.keyFor(epoch) ?: return null.also { onMissingEpoch(epoch) }
		return runCatching { Crypto.openContent(env, key, aad(epoch, kind, id)).toString(Charsets.UTF_8) }.getOrNull()
	}

	// Match vaultAadKind byte for byte.
	private fun aad(epoch: Int, kind: String, id: String) =
		Crypto.ContentAad(boot.domainId, boot.ownerSignPub, epoch, vaultAadKind(kind, id))
}
