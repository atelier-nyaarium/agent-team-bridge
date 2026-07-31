package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ChannelFile
import java.io.File

/**
 * Decodes inbound attachment bytes to app-private storage and maps them to URLs
 * the WebView can load through the asset loader. Bytes never reach the renderer;
 * it only sees {name, mime, src} where src is an appassets-proxied local path.
 *
 * Agent-authored filenames are untrusted, so every name is reduced to a basename
 * and sanitized before it touches the filesystem - a "../../x" name cannot escape
 * the attachments directory.
 */
object Attachments {
	const val DIR = "attachments"
	private const val ASSET_BASE = "https://appassets.androidplatform.net/$DIR"

	/** The one mounted root the WebView loads through. Anything drawn in the transcript has to sit
	 * under it, video frames included, so this is not private. */
	internal fun assetBase(): String = ASSET_BASE

	// sweepOrphanBuckets' default age floor: how long an unreferenced bucket must sit before it
	// is treated as safe to delete outright, rather than possibly still being written into by a
	// decode whose row has not reached a durable write yet. A generous round number - internal so
	// AttachmentsTest can pin the real value instead of re-typing the literal.
	internal const val ORPHAN_SWEEP_MIN_AGE_MS = 600_000L

	fun root(filesDir: File): File = File(filesDir, DIR)

	/** Delete every attachment byte this device holds: the rendered copies AND the blob store the
	 * fetch path keeps them in. Wired into the one-shot schema migration and into
	 * Revoke-and-Delete, so a wipe that never touches filesDir cannot leave message bytes behind.
	 * The two roots are siblings, so purging only one silently keeps a complete second copy. */
	fun purgeAll(filesDir: File) {
		root(filesDir).deleteRecursively()
		BlobStore.root(filesDir).deleteRecursively()
		// Thumbnails outlive their files in memory, so a purge that skipped this would keep drawing
		// revoked attachments until the process died.
		ThumbCache.clear()
		// The frames went with the root above, so nothing may still be counted as ready.
		FrameReadiness.clear()
	}

	/** Basename only, with anything outside a safe charset collapsed to '_'. */
	fun safeName(name: String): String {
		val base = name.substringAfterLast('/').substringAfterLast('\\').trim()
		val cleaned = base.replace(Regex("[^A-Za-z0-9._-]"), "_").trimStart('.')
		return cleaned.ifEmpty { "file" }.take(120)
	}

	/** Suffix a name so two files that sanitize to the same basename in one message
	 * do not overwrite each other on disk. */
	private fun uniqueName(name: String, used: MutableSet<String>): String {
		if (used.add(name)) return name
		val dot = name.lastIndexOf('.')
		val stem = if (dot > 0) name.substring(0, dot) else name
		val ext = if (dot > 0) name.substring(dot) else ""
		var i = 1
		var candidate: String
		do {
			candidate = "$stem-$i$ext"
			i++
		} while (!used.add(candidate))
		return candidate
	}

	/** The attachments bucket a message's files live under. Derived from the row's own position, so
	 * a later fetch lands beside whatever the first pass already wrote. */
	fun bucketFor(epoch: Long, seq: Long): String = "$epoch-$seq"

	/**
	 * Map a message's wire files to renderer DTOs.
	 *
	 * Never blocks and never touches the network, because this runs inside the mailbox drain and a
	 * message must not wait on its attachments to be delivered. A file comes back naming its bytes
	 * and carrying no src; [land] finishes it once the fetch completes. A file naming no bytes at
	 * all is metadata-only and stays that way.
	 */
	fun decode(raw: List<ChannelFile>?): List<MessageFile> {
		if (raw.isNullOrEmpty()) return emptyList()
		val used = mutableSetOf<String>()
		return raw.map { f ->
			MessageFile(
				uniqueName(safeName(f.filename), used),
				f.mime,
				null,
				f.size,
				f.modifiedAt,
				f.blobId,
				f.blobGateway,
				role = f.role,
				ref = f.ref,
				cardTitle = f.cardTitle,
				cardGroup = f.cardGroup,
				cardWidth = f.cardWidth,
				cardHeight = f.cardHeight,
			)
		}
	}

	/**
	 * Copy fetched blob bytes into a message's bucket and return the src the renderer loads, or null
	 * if the copy failed.
	 *
	 * Stream-wise, never through a ByteArray: a file that was moved a chunk at a time has no reason
	 * to exist whole in memory just to be filed. The blob store keeps its own copy, so a re-landing
	 * after a wipe costs a copy rather than a re-download.
	 */
	fun land(filesDir: File, bucket: String, name: String, source: File): String? {
		val dir = File(root(filesDir), bucket)
		// Unique tmp name: two landings of the same file would otherwise share one path, and the
		// second one's truncate-on-open would hole the first one's copy mid-write.
		val tmp = File(dir, "$name.tmp.${java.util.UUID.randomUUID()}")
		return try {
			dir.mkdirs()
			val out = File(dir, name)
			source.inputStream().use { input -> tmp.outputStream().use(input::copyTo) }
			// The rename is the commit. Reporting a src for a file that did not land would mark the
			// row fetched, and a fetched row is never retried, so a recoverable failure would become
			// a permanent one.
			if (tmp.renameTo(out)) "$ASSET_BASE/$bucket/$name" else null
		} catch (_: Exception) {
			null
		} finally {
			// Whatever went wrong, the partial goes with it. The usual trigger here is a full disk,
			// and the retry runs once per poll pass with a fresh name, so leaking on this path would
			// consume more of the exact resource whose exhaustion caused the failure. Nothing else
			// collects these: the orphan sweep only removes whole unreferenced BUCKETS, and a bucket
			// with one landed sibling is referenced.
			tmp.delete()
		}
	}

	/** Persist outbound (user-picked) files so the sent message can show its own
	 * thumbnails through the same asset-loader path as inbound attachments. */
	fun storeOutgoing(filesDir: File, bucket: String, files: List<OutgoingFile>): List<MessageFile> =
		storeOutgoingPaired(filesDir, bucket, files).map { (_, stored) -> stored }

	/** [storeOutgoing], but reporting which input each stored file came from. A caller holding
	 * per-pick side data cannot pair by position, because a failed write is dropped rather than
	 * held as a gap. */
	fun storeOutgoingPaired(
		filesDir: File,
		bucket: String,
		files: List<OutgoingFile>,
	): List<Pair<OutgoingFile, MessageFile>> {
		if (files.isEmpty()) return emptyList()
		val dir = File(root(filesDir), bucket)
		val used = mutableSetOf<String>()
		return files.mapNotNull { f ->
			val name = uniqueName(safeName(f.name), used)
			runCatching {
				dir.mkdirs()
				val out = File(dir, name)
				// Copied stream-wise rather than through a ByteArray: an admitted file still has no
				// reason to exist whole in memory just to be filed.
				if (out.canonicalFile != f.source.canonicalFile) {
					f.source.inputStream().use { input -> out.outputStream().use(input::copyTo) }
				}
				f to MessageFile(name, f.mime, "$ASSET_BASE/$bucket/$name", f.size, role = "attachment")
			}.getOrNull()
		}
	}

	/**
	 * Resolve an asset-relative path (e.g. "<epoch>-<seq>/<name>") back to a real
	 * file, but only if it stays inside the attachments directory. Returns null on
	 * any traversal attempt so a crafted src cannot reach arbitrary files.
	 */
	fun resolve(filesDir: File, relPath: String): File? {
		val rootCanonical = root(filesDir).canonicalFile
		val target = File(rootCanonical, relPath.removePrefix("$DIR/")).canonicalFile
		return if (target.path == rootCanonical.path || target.path.startsWith(rootCanonical.path + File.separator)) {
			target.takeIf { it.isFile }
		} else {
			null
		}
	}

	/** The attachments-relative path component of a src (e.g. "1234-5/photo.jpg" out of the full
	 * appassets URL), or null for a metadata-only file (no src) or an unresolvable one. The one
	 * parse every src consumer shares, including the composer, which is why it is not private. */
	internal fun relOf(src: String?): String? = src?.substringAfter("/$DIR/", "")?.takeIf { it.isNotEmpty() }

	/** A [MessageFile.src] resolved back to its on-disk File via [resolve] - the traversal-safe
	 * idiom every src consumer shares. Null for a metadata-only file (no src) or an unresolvable
	 * path. */
	fun fileFor(filesDir: File, src: String?): File? = relOf(src)?.let { resolve(filesDir, it) }

	/** The bucket-name path segment of a src (e.g. "1234-5" from ".../attachments/1234-5/x"),
	 * or null for a metadata-only file or an unresolvable src. */
	fun bucketOf(src: String?): String? = relOf(src)?.substringBefore('/', "")?.takeIf { it.isNotEmpty() }

	/** Delete the given files by their `src`, then remove any bucket dir left empty afterward.
	 * Deletes per-file, never a bucket wholesale - a row's own bucket can have some files
	 * superseded (deletable) and others retained via a merge that keeps the old src (see
	 * [mergeSentEchoFiles]), so even one row's own bucket needs file-granular deletion, not a
	 * recursive wipe. Only a dir provably empty once its own files are removed is deleted. */
	fun deleteFiles(filesDir: File, srcs: List<String>) {
		val touchedDirs = mutableSetOf<File>()
		for (src in srcs) {
			val file = fileFor(filesDir, src) ?: continue
			file.parentFile?.let { touchedDirs += it }
			file.delete()
		}
		for (dir in touchedDirs) {
			if (dir.listFiles()?.isEmpty() == true) dir.delete()
		}
	}

	/** A bucket dir's age in ms, or null if [File.lastModified] could not be read (0L - its
	 * documented I/O-failure sentinel, not a real 1970 timestamp). Kept as its own nullable
	 * result rather than folded into a single boolean check, so "age unknown" stays a distinct,
	 * structurally-visible case a future edit to the young-bucket check cannot silently drop. */
	private fun File.orphanAgeMs(now: Long): Long? = lastModified().takeIf { it != 0L }?.let { now - it }

	/** Delete every attachment bucket with no reference among [referencedSrcs] (every surviving
	 * row's file srcs, across every thread - pass real srcs, not pre-computed bucket names; this
	 * reduces them via [bucketOf] itself, so the one existing caller no longer has to). The
	 * completeness backstop for [deleteFiles]: heals a crash between a durable row-state write and the
	 * best-effort file delete, a historical orphan predating this sweep, or a future
	 * decode-without-row case. A bucket younger than [minAgeMs], or whose age cannot be read, is
	 * left alone: it may be referenced by a row not yet durable. The caller must never run this
	 * concurrently with anything that could still decode into a bucket (mtime updates the
	 * instant a file is written into it, so sequencing strictly before any write is the only
	 * safe ordering - a concurrent sweep cannot be made safe by the age guard alone). */
	fun sweepOrphanBuckets(
		filesDir: File,
		referencedSrcs: Collection<String?>,
		// Buckets that no src points at. A video's frame set is reachable only through the file it was
		// extracted from, so it has to be named here or the sweep treats it as orphaned. Exempting the
		// whole family by name prefix instead would make it unreclaimable, since this sweep is the only
		// thing that deletes a bucket wholesale.
		keepBuckets: Set<String> = emptySet(),
		minAgeMs: Long = ORPHAN_SWEEP_MIN_AGE_MS,
	) {
		val referencedBuckets = referencedSrcs.mapNotNull { bucketOf(it) }.toSet() + keepBuckets
		val now = System.currentTimeMillis()
		val dirs = root(filesDir).listFiles()?.filter { it.isDirectory } ?: return
		for (dir in dirs) {
			if (dir.name in referencedBuckets) continue
			val age = dir.orphanAgeMs(now) ?: continue
			if (age < minAgeMs) continue
			dir.deleteRecursively()
		}
	}

	/** [mergeSentEchoFiles]'s result: the files the replaced row should carry, and the srcs now
	 * safe to delete. */
	data class SentEchoMerge(val files: List<MessageFile>, val deleteSrcs: List<String>)

	/** The attachment merge for a `sentEchoMatch` replace (see ChatRepository.reconcileSent):
	 * files paired by name (both the optimistic store and the mirror decode derive names through
	 * the same safeName/uniqueName chain, so names are stable across the replace - a positional
	 * pairing would drift if an earlier storeOutgoing write failed and was dropped). An echo file
	 * that itself carries bytes (non-null src) wins; one that does not (a metadata-only mirror -
	 * not reachable today, kept as a defensive case) keeps the OLD row's src instead of losing
	 * its reference. `deleteSrcs` is old's srcs minus the merged result's srcs, which is exactly
	 * the orphaned set across every sentEchoMatch fold shape: a fresh mirror orphans the old
	 * row's outbound bucket; a same-bucket re-drain fold (the old row was already upgraded)
	 * cancels to nothing, since old and new already agree; a fresh-seq re-send fold orphans the
	 * earlier inbound bucket instead. */
	fun mergeSentEchoFiles(oldFiles: List<MessageFile>, echoFiles: List<MessageFile>): SentEchoMerge {
		val oldByName = oldFiles.associateBy { it.name }
		val merged = echoFiles.map { echo ->
			if (echo.src != null) echo else oldByName[echo.name]?.let { echo.copy(src = it.src) } ?: echo
		}
		val mergedSrcs = merged.mapNotNull { it.src }.toSet()
		val deleteSrcs = oldFiles.mapNotNull { it.src }.filterNot { it in mergedSrcs }
		return SentEchoMerge(merged, deleteSrcs)
	}
}
