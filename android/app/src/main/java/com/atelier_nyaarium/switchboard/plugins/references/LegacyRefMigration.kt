package com.atelier_nyaarium.switchboard.plugins.references

import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.Message
import com.atelier_nyaarium.switchboard.MessageFile
import com.atelier_nyaarium.switchboard.proto.RefFileMeta
import com.atelier_nyaarium.switchboard.proto.RefKeyMeta
import com.atelier_nyaarium.switchboard.proto.RefSegmentMeta
import com.atelier_nyaarium.switchboard.proto.RefSpanMeta
import java.io.File
import org.json.JSONObject

////////////////////////////////
//  Legacy row migration
//
//  TODO(2026-09): remove this module, the STAMP_ROLES branch in ChatRepository's init, and
//  AppStateStore.ROLE_MIGRATION_FROM_VERSION once the owner's install has run it (single-user
//  fleet; it is dead code after one boot on the new build).
//
//  Pre-role rows carry no `role` and describe their ref snapshots through a manifest FILE under the
//  old reserved name. This one-shot converter stamps the meaning in: roles by the positional
//  convention the rows were written under, and per-file ref metadata reconstructed from the on-disk
//  manifest bytes. Runs once behind the schema-version latch, then nothing reads manifests again.
//
//  Additive only: it fills absent fields and never removes one, so re-running after an interrupted
//  pass converges instead of compounding. A row whose manifest never landed (or predates the
//  References plugin) still gets its roles stamped; its ref links then decline to the link menu,
//  the documented miss contract.

////////////////////////////////
//  Functions & Helpers

/** The pre-role wire's reserved manifest filename, alive here ONLY to classify rows persisted
 * under that convention. Nothing on the live path reads it. */
private const val LEGACY_MANIFEST_FILENAME = "switchboard-references.json"

/** The old manifest's self-describing top-level key; a reserved-name file without it is not one. */
private const val LEGACY_MANIFEST_MARKER = "switchboardReferences"

/** The old consumer's bound on a manifest read, kept for the same reason it had it: anything this
 * size is not a manifest. */
private const val MAX_LEGACY_MANIFEST_BYTES = 512 * 1024

/** The wire's per-file array caps (channel-file.ts REF_META_MAX_*), applied here so a reconstructed
 * block never exceeds what a fresh sender could declare. */
private const val MAX_META_ENTRIES = 64

internal object LegacyRefMigration {

	/** Convert one team's rows. A row where any file already carries a role was written post-role
	 * and passes through untouched. */
	fun migrate(rows: List<Message>, filesDir: File): List<Message> = rows.map { migrateRow(it, filesDir) }

	private fun migrateRow(row: Message, filesDir: File): Message {
		if (row.files.isEmpty() || row.files.any { it.role != null }) return row
		// An own row never carried machinery (only agent replies appended artifacts), so the
		// positional rule must not touch it: a file the owner named like the old manifest is a
		// genuine attachment, and relabeling it would hide the owner's own file.
		val manifestAt = if (row.fromMe) -1 else row.files.indexOfFirst { it.name == LEGACY_MANIFEST_FILENAME }
		val metaByName = if (manifestAt == -1) emptyMap() else refMetaByFilename(row.files[manifestAt], filesDir)
		val files = row.files.mapIndexed { i, f ->
			if (manifestAt != -1 && i >= manifestAt) {
				// The manifest entry itself stamps as a snapshot: machinery like the files it named.
				f.copy(role = "ref-snapshot", ref = metaByName[f.name])
			} else {
				f.copy(role = "attachment")
			}
		}
		return row.copy(files = files)
	}

	/** The per-file ref metadata a legacy manifest described, keyed by the landing filename it
	 * recorded, or empty when the manifest is absent, unreadable, oversize, or not one. */
	private fun refMetaByFilename(manifest: MessageFile, filesDir: File): Map<String, RefFileMeta> {
		val src = manifest.src ?: return emptyMap()
		val rel = src.substringAfter("attachments/", src)
		val onDisk = Attachments.resolve(filesDir, rel) ?: return emptyMap()
		if (onDisk.length() > MAX_LEGACY_MANIFEST_BYTES) return emptyMap()
		val root = runCatching { JSONObject(onDisk.readText()) }.getOrNull() ?: return emptyMap()
		if (!root.has(LEGACY_MANIFEST_MARKER)) return emptyMap()

		// refs: canonical key -> {refPath, startLine, endLine, span?, quality, ...}, regrouped by the
		// file that backs them.
		val keysByPath = HashMap<String, MutableList<RefKeyMeta>>()
		val refs = root.optJSONObject("refs") ?: JSONObject()
		for (key in refs.keys()) {
			val entry = refs.optJSONObject(key) ?: continue
			val refPath = entry.optString("refPath").takeIf { it.isNotEmpty() } ?: continue
			keysByPath.getOrPut(refPath) { mutableListOf() }.add(
				RefKeyMeta(
					key = key,
					startLine = entry.optLong("startLine", 1),
					endLine = entry.optLong("endLine", 1),
					span = entry.optJSONObject("span")?.let { s ->
						RefSpanMeta(
							startLine = s.optLong("startLine", 1),
							startColumn = s.optLong("startColumn", 0),
							endLine = s.optLong("endLine", 1),
							endColumn = s.optLong("endColumn", 0),
						)
					},
					quality = entry.optString("quality").ifEmpty { "exact" },
					reason = entry.optString("reason").takeIf { it.isNotEmpty() },
					ambiguous = if (entry.optBoolean("ambiguous")) true else null,
					matchCount = if (entry.has("matchCount")) entry.optLong("matchCount") else null,
				),
			)
		}

		val out = HashMap<String, RefFileMeta>()
		val files = root.optJSONArray("files") ?: return emptyMap()
		for (i in 0 until files.length()) {
			val entry = files.optJSONObject(i) ?: continue
			val filename = entry.optString("filename").takeIf { it.isNotEmpty() } ?: continue
			val refPath = entry.optString("refPath").takeIf { it.isNotEmpty() } ?: continue
			// Old segments carried their text; the wire form carries line counts, because the
			// snapshot file IS the segments' text joined with newlines.
			val segments = entry.optJSONArray("segments")?.let { arr ->
				(0 until arr.length()).mapNotNull { j ->
					arr.optJSONObject(j)?.let { s ->
						RefSegmentMeta(
							startLine = s.optLong("startLine", 1),
							lineCount = s.optString("text").split("\n").size.toLong(),
						)
					}
				}
			}?.takeIf { it.isNotEmpty() && entry.optString("mode") == "snippet" }?.take(MAX_META_ENTRIES)
			out[filename] = RefFileMeta(
				refPath = refPath,
				segments = segments,
				keys = (keysByPath[refPath] ?: emptyList()).take(MAX_META_ENTRIES),
			)
		}
		return out
	}
}
