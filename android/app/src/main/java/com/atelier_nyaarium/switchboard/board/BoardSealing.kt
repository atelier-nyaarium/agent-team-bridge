package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.BOARD_BODY_KIND
import com.atelier_nyaarium.switchboard.crypto.BOARD_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.BOARD_NAME_KIND
import com.atelier_nyaarium.switchboard.crypto.boardTextAadKind
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope

const val BOARD_KIND_TITLE = BOARD_TITLE_KIND
const val BOARD_KIND_BODY = BOARD_BODY_KIND

/** Uses the domain root key for AAD. */
class BoardSealing(
	private val keyring: ContentKeyring,
	private val domainId: String,
	private val ownerSignPub: String,
	private val onMissingEpoch: (Int) -> Unit = {},
) {
	fun seal(text: String, kind: String, entryId: String): ContentEnvelope? {
		val epoch = keyring.epochs().maxOrNull() ?: return null
		val key = keyring.keyFor(epoch) ?: return null.also { onMissingEpoch(epoch) }
		return Crypto.sealContent(text.toByteArray(Charsets.UTF_8), key, aad(epoch, kind, entryId))
	}

	fun open(env: ContentEnvelope, kind: String, entryId: String): String? {
		val epoch = env.epoch.toInt()
		val key = keyring.keyFor(epoch) ?: return null.also { onMissingEpoch(epoch) }
		return runCatching {
			Crypto.openContent(env, key, aad(epoch, kind, entryId)).toString(Charsets.UTF_8)
		}.getOrNull()
	}

	// Match boardTextAadKind byte for byte; revision stays unbound.
	private fun aad(epoch: Int, kind: String, entryId: String) =
		Crypto.ContentAad(domainId, ownerSignPub, epoch, boardTextAadKind(kind, entryId))
}
