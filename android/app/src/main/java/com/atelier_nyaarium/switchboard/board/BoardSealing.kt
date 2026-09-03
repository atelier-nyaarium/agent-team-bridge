package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope

/** Separate AAD kinds prevent slot confusion. */
const val BOARD_KIND_TITLE = "board.title"
const val BOARD_KIND_BODY = "board.body"

/** Uses the domain root key for AAD. */
class BoardSealing(
	private val keyring: ContentKeyring,
	private val domainId: String,
	private val ownerSignPub: String,
) {
	fun seal(text: String, kind: String, entryId: String): ContentEnvelope? {
		val epoch = keyring.epochs().maxOrNull() ?: return null
		val key = keyring.keyFor(epoch) ?: return null
		return Crypto.sealContent(text.toByteArray(Charsets.UTF_8), key, aad(epoch, kind, entryId))
	}

	fun open(env: ContentEnvelope, kind: String, entryId: String): String? {
		val epoch = env.epoch.toInt()
		val key = keyring.keyFor(epoch) ?: return null
		return runCatching {
			Crypto.openContent(env, key, aad(epoch, kind, entryId)).toString(Charsets.UTF_8)
		}.getOrNull()
	}

	// Match boardTextAadKind byte for byte; revision stays unbound.
	private fun aad(epoch: Int, kind: String, entryId: String) =
		Crypto.ContentAad(domainId, ownerSignPub, epoch, "$kind\n$entryId")
}
