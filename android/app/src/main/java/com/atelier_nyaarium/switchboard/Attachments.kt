package com.atelier_nyaarium.switchboard

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

	fun root(filesDir: File): File = File(filesDir, DIR)

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
	fun decode(filesDir: File, epoch: Int, seq: Int, raw: List<RawFile>): List<MessageFile> {
		if (raw.isEmpty()) return emptyList()
		val bucket = "$epoch-$seq"
		val dir = File(root(filesDir), bucket)
		val used = mutableSetOf<String>()
		return raw.mapNotNull { f ->
			val name = uniqueName(safeName(f.filename), used)
			if (f.base64 == null) return@mapNotNull MessageFile(name, f.mime, null)
			val bytes = runCatching { Base64.decode(f.base64, Base64.DEFAULT) }.getOrNull() ?: return@mapNotNull null
			runCatching {
				dir.mkdirs()
				val out = File(dir, name)
				// Atomic-ish write so a partial decode never shows a truncated image.
				val tmp = File(dir, "$name.tmp")
				tmp.writeBytes(bytes)
				tmp.renameTo(out)
				MessageFile(name, f.mime, "$ASSET_BASE/$bucket/$name")
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
}
