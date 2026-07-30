package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ChannelFile
import android.util.Base64
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

	// sweepOrphanBuckets' default age floor: how long an unreferenced bucket must sit before it
	// is treated as safe to delete outright, rather than possibly still being written into by a
	// decode whose row has not reached a durable write yet. A generous round number - internal so
	// AttachmentsTest can pin the real value instead of re-typing the literal.
	internal const val ORPHAN_SWEEP_MIN_AGE_MS = 600_000L

	fun root(filesDir: File): File = File(filesDir, DIR)

	/** Delete every materialized attachment under the attachments root. Wired into the one-shot
	 * schema migration so grammar-era message bytes do not stay stranded on disk after the prefs
	 * wipe (which never touched filesDir). */
	fun purgeAll(filesDir: File) {
		root(filesDir).deleteRecursively()
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

	/**
	 * Write each byte-bearing file under attachments/<epoch>-<seq>/ and return the
	 * renderer DTOs. Metadata-only entries (no base64) get a null src so the UI
	 * shows a plain chip with no thumbnail.
	 */
	fun decode(filesDir: File, epoch: Long, seq: Long, raw: List<ChannelFile>?): List<MessageFile> {
		if (raw.isNullOrEmpty()) return emptyList()
		val bucket = "$epoch-$seq"
		val dir = File(root(filesDir), bucket)
		val used = mutableSetOf<String>()
		return raw.mapNotNull { f ->
			val name = uniqueName(safeName(f.filename), used)
			// Empty base64 is metadata-only too: decoding it would materialize a
			// 0-byte file and hand the WebView a broken image src.
			if (f.base64.isNullOrEmpty()) return@mapNotNull MessageFile(name, f.mime, null, f.size, f.modifiedAt)
			val bytes = runCatching { Base64.decode(f.base64, Base64.DEFAULT) }.getOrNull() ?: return@mapNotNull null
			runCatching {
				dir.mkdirs()
				val out = File(dir, name)
				// Atomic-ish write so a partial decode never shows a truncated image.
				val tmp = File(dir, "$name.tmp")
				tmp.writeBytes(bytes)
				tmp.renameTo(out)
				MessageFile(name, f.mime, "$ASSET_BASE/$bucket/$name", bytes.size.toLong(), f.modifiedAt)
			}.getOrNull()
		}
	}

	/** Persist outbound (user-picked) files so the sent message can show its own
	 * thumbnails through the same asset-loader path as inbound attachments. */
	fun storeOutgoing(filesDir: File, bucket: String, files: List<OutgoingFile>): List<MessageFile> {
		if (files.isEmpty()) return emptyList()
		val dir = File(root(filesDir), bucket)
		val used = mutableSetOf<String>()
		return files.mapNotNull { f ->
			val name = uniqueName(safeName(f.name), used)
			runCatching {
				dir.mkdirs()
				File(dir, name).writeBytes(f.bytes)
				MessageFile(name, f.mime, "$ASSET_BASE/$bucket/$name", f.bytes.size.toLong())
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
	 * parse every src consumer below shares. */
	private fun relOf(src: String?): String? = src?.substringAfter("/$DIR/", "")?.takeIf { it.isNotEmpty() }

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
	fun sweepOrphanBuckets(filesDir: File, referencedSrcs: Collection<String?>, minAgeMs: Long = ORPHAN_SWEEP_MIN_AGE_MS) {
		val referencedBuckets = referencedSrcs.mapNotNull { bucketOf(it) }.toSet()
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
