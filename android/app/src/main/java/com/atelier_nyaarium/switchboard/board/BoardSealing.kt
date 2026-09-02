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
	fun seal(text: String, kind: String, entryId: String): ContentEnvelope? {
		val epoch = keyring.epochs().maxOrNull() ?: return null
		val key = keyring.keyFor(epoch) ?: return null
		return Crypto.sealContent(text.toByteArray(Charsets.UTF_8), key, aad(epoch, kind, entryId))
	}

	/** Null when the sealing epoch is absent or the envelope does not authenticate. */
	fun open(env: ContentEnvelope, kind: String, entryId: String): String? {
		val epoch = env.epoch.toInt()
		val key = keyring.keyFor(epoch) ?: return null
		return runCatching {
			Crypto.openContent(env, key, aad(epoch, kind, entryId)).toString(Charsets.UTF_8)
		}.getOrNull()
	}

	// Bind ciphertext to entry id.
	// Match boardTextAadKind in content-envelope.ts.
	private fun aad(epoch: Int, kind: String, entryId: String) =
		Crypto.ContentAad(domainId, ownerSignPub, epoch, "$kind\n$entryId")
}
