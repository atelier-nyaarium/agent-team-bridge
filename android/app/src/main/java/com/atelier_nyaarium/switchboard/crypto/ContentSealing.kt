package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.PhoneAmbient
import com.atelier_nyaarium.switchboard.PhoneBootstrap
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope

/** One sealing door per record kind; the AAD builder is the only difference between them. */
open class ContentSealing(
	private val boot: PhoneBootstrap,
	private val ambient: PhoneAmbient,
	private val aadKind: (kind: String, id: String) -> String,
	private val onMissingEpoch: (Int) -> Unit,
) {
	val epochs: List<Int>
		get() = boot.contentKeyring.epochs()

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

	private fun aad(epoch: Int, kind: String, id: String) =
		Crypto.ContentAad(boot.domainId, boot.ownerSignPub, epoch, aadKind(kind, id))
}
