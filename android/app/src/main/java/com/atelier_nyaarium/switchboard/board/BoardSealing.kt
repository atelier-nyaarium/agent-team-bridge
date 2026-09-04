package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.PhoneAmbient
import com.atelier_nyaarium.switchboard.PhoneBootstrap
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.BOARD_BODY_KIND
import com.atelier_nyaarium.switchboard.crypto.BOARD_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.boardTextAadKind
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope

const val BOARD_KIND_TITLE = BOARD_TITLE_KIND
const val BOARD_KIND_BODY = BOARD_BODY_KIND

/** Uses the domain root key for AAD. */
open class BoardSealing(
	private val boot: PhoneBootstrap,
	private val ambient: PhoneAmbient,
	private val onMissingEpoch: (Int) -> Unit,
) {
	val epochs: List<Int>
		get() = boot.contentKeyring.epochs()

	fun seal(text: String, kind: String, entryId: String): ContentEnvelope? {
		val epoch = boot.contentKeyring.epochs().maxOrNull() ?: return null
		val key = boot.contentKeyring.keyFor(epoch) ?: return null.also { onMissingEpoch(epoch) }
		val bytes = text.toByteArray(Charsets.UTF_8)
		return Crypto.sealContent(bytes, key, aad(epoch, kind, entryId), ambient.newNonceBytes())
	}

	open fun open(env: ContentEnvelope, kind: String, entryId: String): String? {
		val epoch = env.epoch.toInt()
		val key = boot.contentKeyring.keyFor(epoch) ?: return null.also { onMissingEpoch(epoch) }
		return runCatching {
			Crypto.openContent(env, key, aad(epoch, kind, entryId)).toString(Charsets.UTF_8)
		}.getOrNull()
	}

	// Match boardTextAadKind byte for byte; revision stays unbound.
	private fun aad(epoch: Int, kind: String, entryId: String) =
		Crypto.ContentAad(boot.domainId, boot.ownerSignPub, epoch, boardTextAadKind(kind, entryId))
}
