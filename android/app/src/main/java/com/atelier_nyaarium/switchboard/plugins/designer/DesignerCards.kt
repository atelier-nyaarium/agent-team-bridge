package com.atelier_nyaarium.switchboard.plugins.designer

import com.atelier_nyaarium.switchboard.Message

/** Attributes parsed off a card's `@dsCard` marker. `width`/`height` are the author's intended
 * viewport (display hints only); `group` is the kit section label. */
data class DsCardMeta(
	val group: String = "",
	val width: Int? = null,
	val height: Int? = null,
)

/** One pushed revision of a canvas. Each same-filename push is its own chat message with its own
 * on-disk attachment bucket, so a version is a durable pointer into existing storage - the history
 * is derived from the message log, not a second copy of the bytes. */
data class DesignerVersion(
	/** The materialized attachment's renderer URL (`https://appassets...`); locates the on-disk HTML. */
	val src: String,
	val at: Long,
	val meta: DsCardMeta,
	/** The HTML `<title>` of this specific revision, or null. */
	val title: String?,
)

/** One design canvas in a conversation's dock: an identity (the filename) plus its full version
 * history, newest last. */
data class DesignerCard(
	/** The attachment filename - the card's IDENTITY. Same filename on a later message appends a
	 * version; a new filename is a new card. */
	val fileName: String,
	/** Display name: the newest version's `<title>`, else the filename stem. */
	val name: String,
	/** Chronological, always non-empty; `last()` is the current revision. */
	val versions: List<DesignerVersion>,
) {
	val latest: DesignerVersion
		get() = versions.last()

	val src: String
		get() = latest.src

	val updatedAt: Long
		get() = latest.at

	val meta: DsCardMeta
		get() = latest.meta
}

// The marker must LEAD the file (same contract as claude.ai/design's self-check): a first-line
// `<!-- @dsCard ... -->` comment, nothing but whitespace before it.
private val MARKER = Regex("""\A\s*<!--\s*@dsCard([^>]*?)-->""")
private val ATTR = Regex("""([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"""")
private val TITLE = Regex("""<title>([^<]*)</title>""", RegexOption.IGNORE_CASE)

/** Parse the leading `@dsCard` marker; null when the content is not a design card. */
fun parseDsCardMarker(html: String): DsCardMeta? {
	val match = MARKER.find(html) ?: return null
	var group = ""
	var width: Int? = null
	var height: Int? = null
	ATTR.findAll(match.groupValues[1]).forEach { attr ->
		val value = attr.groupValues[2]
		when (attr.groupValues[1]) {
			"group" -> group = value
			"width" -> width = value.toIntOrNull()
			"height" -> height = value.toIntOrNull()
		}
	}
	return DsCardMeta(group, width, height)
}

/** The HTML `<title>` text, or null when absent/blank. */
fun htmlTitle(html: String): String? = TITLE.find(html)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }

/** Whether an attachment looks like an HTML file by mime or extension. */
internal fun looksHtml(mime: String, name: String): Boolean =
	mime.startsWith("text/html") || name.endsWith(".html", ignoreCase = true) || name.endsWith(".htm", ignoreCase = true)

/**
 * Derive a conversation's design cards (with version history) from its messages - the index is a
 * VIEW over thread state plus a small dismissed overlay, never a second persisted copy of the
 * content (so `forget()`, schema wipes, and attachment eviction can not leave a stale index
 * behind; see plans/plugins.md). An attachment is a card version when it is an HTML file whose
 * content leads with the `@dsCard` marker. Same filename across messages accumulates versions in
 * chronological order; a new filename is a new card. Cards keep first-appearance order.
 *
 * PEER-MIRROR ROWS ARE EXCLUDED (`Message.isPeer`): a mirrored agent-to-agent exchange's
 * attachments belong to that other exchange, and folding them in by filename would let an
 * unrelated card seed or overwrite one the human's own agent pushed here.
 *
 * [dismissed] maps a filename to the newest-version timestamp AT THE MOMENT it was deleted. A card
 * is hidden while its newest version is not newer than that marker; a strictly-later re-push
 * (a deliberate new revision) clears the tombstone by exceeding it. [readHtml] resolves an
 * attachment src to its text (injected: the app reads the materialized file, tests read fixtures);
 * an unresolvable attachment is simply not a card version.
 */
fun designerCards(
	messages: List<Message>,
	dismissed: Map<String, Long> = emptyMap(),
	readHtml: (src: String) -> String?,
): List<DesignerCard> {
	val byFile = LinkedHashMap<String, MutableList<DesignerVersion>>()
	for (msg in messages) {
		if (msg.isPeer) continue
		for (f in msg.files) {
			val src = f.src ?: continue
			if (!looksHtml(f.mime, f.name)) continue
			val html = readHtml(src) ?: continue
			val meta = parseDsCardMarker(html) ?: continue
			val versions = byFile.getOrPut(f.name) { mutableListOf() }
			if (versions.any { it.src == src }) continue // idempotent re-derive
			versions.add(DesignerVersion(src, msg.at, meta, htmlTitle(html)))
		}
	}
	return byFile.entries.mapNotNull { (fileName, versions) ->
		versions.sortBy { it.at }
		val latest = versions.last()
		val tombstone = dismissed[fileName]
		if (tombstone != null && latest.at <= tombstone) return@mapNotNull null
		DesignerCard(fileName, latest.title ?: fileName.substringBeforeLast('.'), versions.toList())
	}
}
