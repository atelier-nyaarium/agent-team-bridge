package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File

////////////////////////////////
//  Functions & Helpers

/**
 * Where a saved attachment goes.
 *
 * There are two writers, not one, and neither can serve both cases. Downloads is reachable with no
 * permission at all through MediaStore, which is what makes a FIRST save possible: until the user
 * has picked a folder there is no persisted grant, so there is no tree Uri to write to. Once they
 * have picked one, that grant is the only way to reach a folder outside Downloads.
 *
 * A remembered grant is not durable. Clearing app data, deleting the folder, unmounting the volume,
 * or revoking the permission all leave the stored Uri looking fine while the write throws. Every
 * read therefore re-validates, so a dead grant degrades to the picker rather than to a bare "Save
 * failed" that gives the user nothing to act on.
 *
 * Takes the stored string rather than a store, so nothing here depends on where it is kept.
 */
object SaveTarget {
	/** Ask for a folder. The result Uri must go through [persist] or the grant dies with the process. */
	fun pickFolderIntent(): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
		addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
	}

	/** Take the long-lived grant. False when the system refused it, in which case the caller must not
	 * store the Uri: a stored Uri with no grant is indistinguishable from a working one until a write
	 * fails. */
	fun persist(context: Context, tree: Uri): Boolean = runCatching {
		context.contentResolver.takePersistableUriPermission(
			tree,
			Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
		)
		true
	}.getOrDefault(false)

	/**
	 * The remembered folder, but only if it is still writable right now.
	 *
	 * Checks the grant AND that the directory still resolves. A folder the user deleted keeps its
	 * permission entry, so the permission check alone still hands back a Uri that throws on write.
	 */
	fun writableTree(context: Context, stored: String): Uri? {
		if (stored.isBlank()) return null
		val tree = runCatching { Uri.parse(stored) }.getOrNull() ?: return null
		val granted = context.contentResolver.persistedUriPermissions.any {
			it.uri == tree && it.isWritePermission
		}
		if (!granted) return null
		return if (directoryUri(context.contentResolver, tree) != null) tree else null
	}

	/** A short label for the chosen folder, or null when none is usable. */
	fun label(context: Context, stored: String): String? {
		val tree = writableTree(context, stored) ?: return null
		val id = runCatching { DocumentsContract.getTreeDocumentId(tree) }.getOrNull() ?: return null
		// Provider ids look like "primary:Pictures/Trips"; the tail is the part a user recognizes.
		return id.substringAfterLast(':').substringAfterLast('/').ifBlank { null }
	}

	/** Write into the chosen folder. False when the grant died between the check and the write, which
	 * the caller turns into a re-pick rather than a dead end. */
	fun writeToTree(context: Context, tree: Uri, source: File, name: String, mime: String): Boolean = runCatching {
		val resolver = context.contentResolver
		val dir = directoryUri(resolver, tree) ?: return false
		val type = mime.ifBlank { "application/octet-stream" }
		val target = DocumentsContract.createDocument(resolver, dir, type, name) ?: return false
		resolver.openOutputStream(target)?.use { out -> source.inputStream().use { it.copyTo(out) } } ?: return false
		// No mtime restore: SAF exposes no setter, and a provider that silently ignored an attempt
		// would leave the file looking stamped when it is not.
		true
	}.getOrDefault(false)

	private fun directoryUri(resolver: ContentResolver, tree: Uri): Uri? = runCatching {
		val id = DocumentsContract.getTreeDocumentId(tree)
		val dir = DocumentsContract.buildDocumentUriUsingTree(tree, id)
		// Querying is what separates a live folder from a deleted one; building the Uri always works.
		resolver.query(dir, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)
			?.use { if (it.moveToFirst()) dir else null }
	}.getOrNull()
}
