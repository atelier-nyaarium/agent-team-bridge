package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope

/** AAD kinds. A title opened as a body fails authentication rather than rendering in the wrong slot. */
const val BOARD_KIND_TITLE = "board.title"
const val BOARD_KIND_BODY = "board.body"

/**
 * Seals and opens board text against the content keyring.
 *
 * [ownerSignPub] is the DOMAIN ROOT key, never this device's own identity. On a secondary console
 * the two differ, and using the device's key builds an AAD the writer's Router copy cannot open.
 */
class BoardSealing(
	private val keyring: ContentKeyring,
	private val domainId: String,
	private val ownerSignPub: String,
) {
	/** Null when this device holds no epoch, which is a device that cannot write board text at all. */
	fun seal(text: String, kind: String): ContentEnvelope? {
		val epoch = keyring.epochs().maxOrNull() ?: return null
		val key = keyring.keyFor(epoch) ?: return null
		return Crypto.sealContent(text.toByteArray(Charsets.UTF_8), key, aad(epoch, kind))
	}

	/** Null when the sealing epoch is absent or the envelope does not authenticate. */
	fun open(env: ContentEnvelope, kind: String): String? {
		val epoch = env.epoch.toInt()
		val key = keyring.keyFor(epoch) ?: return null
		return runCatching { Crypto.openContent(env, key, aad(epoch, kind)).toString(Charsets.UTF_8) }.getOrNull()
	}

	private fun aad(epoch: Int, kind: String) = Crypto.ContentAad(domainId, ownerSignPub, epoch, kind)
}
