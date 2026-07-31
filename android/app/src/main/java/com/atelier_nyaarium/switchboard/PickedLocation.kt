package com.atelier_nyaarium.switchboard

import android.net.Uri
import android.provider.DocumentsContract

////////////////////////////////
//  Functions & Helpers

/**
 * Where a picked file came from, as something a user recognizes.
 *
 * Storage Access Framework exposes no user-visible path, so there is nothing to show but what the
 * provider chose to put in its document id. That is also the safer answer: this reports ONE segment,
 * never a folder chain, so it cannot carry a username or a layout even by accident. A provider using
 * opaque ids yields nothing and the caller omits the row rather than guessing.
 *
 * Draft-only by construction. Nothing here is ever attached to a file type, so there is no
 * conversion that could carry it onto the wire.
 */
object PickedLocation {
	/** Read at pick time, which is the only moment the content Uri is in hand. */
	fun of(uri: Uri): String? =
		runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()?.let(::segmentOf)

	/** External storage spells a document id "primary:Download/photo.jpg", so the part after the
	 * authority prefix is the only path-like component a provider offers. Taken over the id alone so
	 * it is testable without a real provider. */
	internal fun segmentOf(documentId: String): String? {
		val path = documentId.substringAfter(':', "")
		val parent = path.substringBeforeLast('/', "")
		return parent.substringAfterLast('/').takeIf { it.isNotBlank() }
	}
}
