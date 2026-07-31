package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File

////////////////////////////////
//  Interfaces & Types

/** How a write into the chosen folder ended. The two failures are distinct because their recoveries
 * are: one wants a re-pick, the other must not trigger one. */
sealed interface SaveOutcome {
	data object Ok : SaveOutcome

	/** The folder or its grant is gone. */
	data object FolderGone : SaveOutcome

	/** The folder was reachable and the write itself failed, so the destination is not the problem. */
	data object WriteFailed : SaveOutcome
}

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
	private const val OPAQUE_MIME = "application/octet-stream"

	/** The type that makes createDocument produce a FOLDER. Spelled out rather than read from
	 * DocumentsContract so the guard stays a pure function a JVM test can exercise. */
	private const val DIRECTORY_MIME = "vnd.android.document/directory"

	/** A plain type/subtype, per RFC 6838's restricted-name shape. */
	private val MIME_SHAPE = Regex("""[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}""")

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

	/**
	 * Write into the chosen folder.
	 *
	 * Reports WHICH way it failed, because the two have opposite recoveries. A folder that is gone
	 * needs a re-pick; a folder that is present but could not be written to does not, and re-picking
	 * there would cost the user their setting to fix something the setting was not causing.
	 */
	fun writeToTree(context: Context, tree: Uri, source: File, name: String, mime: String): SaveOutcome {
		val resolver = context.contentResolver
		val dir = directoryUri(resolver, tree) ?: return SaveOutcome.FolderGone
		val target = runCatching { DocumentsContract.createDocument(resolver, dir, documentMime(mime), name) }
			.getOrNull() ?: return SaveOutcome.FolderGone
		val wrote = runCatching {
			resolver.openOutputStream(target)?.use { out -> source.inputStream().use { it.copyTo(out) } } != null
		}.getOrDefault(false)
		if (!wrote) {
			// A half-written document carries the real filename with nothing marking it incomplete, so
			// leaving it behind hands the user a corrupt file that looks like the one they saved. SAF
			// has no pending flag like MediaStore's, so the only way to not publish a torn write is to
			// remove it.
			runCatching { DocumentsContract.deleteDocument(resolver, target) }
			return SaveOutcome.WriteFailed
		}
		// No mtime restore: SAF exposes no setter, and a provider that silently ignored an attempt
		// would leave the file looking stamped when it is not.
		return SaveOutcome.Ok
	}

	/**
	 * The type handed to createDocument.
	 *
	 * The mime here comes off the wire and nothing upstream constrains it, so it cannot be trusted to
	 * name a file at all: the directory type would make the provider create a FOLDER in the user's
	 * chosen location. Anything that is not a plain type/subtype is stored as opaque bytes instead.
	 */
	internal fun documentMime(mime: String): String {
		val m = mime.substringBefore(';').trim().lowercase()
		if (m == DIRECTORY_MIME) return OPAQUE_MIME
		return if (MIME_SHAPE.matches(m)) m else OPAQUE_MIME
	}

	private fun directoryUri(resolver: ContentResolver, tree: Uri): Uri? = runCatching {
		val id = DocumentsContract.getTreeDocumentId(tree)
		val dir = DocumentsContract.buildDocumentUriUsingTree(tree, id)
		// Querying is what separates a live folder from a deleted one; building the Uri always works.
		resolver.query(dir, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)
			?.use { if (it.moveToFirst()) dir else null }
	}.getOrNull()
}
