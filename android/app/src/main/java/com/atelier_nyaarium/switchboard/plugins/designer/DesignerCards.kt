package com.atelier_nyaarium.switchboard.plugins.designer

import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.MessageFile

/** Attributes parsed off a card's `@dsCard` marker. `width`/`height` are the author's intended
 * viewport (display hints only); `group` is the kit section label. */
data class DsCardMeta(
	val group: String = "",
	val width: Int? = null,
	val height: Int? = null,
)

/** One design canvas in a conversation's dock gallery: the LATEST push of a given filename. There
 * is no version history surfaced - an older revision is just an earlier chat message, reached by
 * scrolling to it and tapping its chip (which opens that exact file). */
data class DesignerCard(
	/** The attachment filename - the card's IDENTITY and the Delete key. */
	val fileName: String,
	/** Display name: the HTML `<title>`, else the filename stem. */
	val name: String,
	/** The attachment-relative path (`<bucket>/<name>`) of the latest push, for rendering + actions. */
	val rel: String,
	val updatedAt: Long,
	val meta: DsCardMeta,
)

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

/** The attachment-relative path (`<bucket>/<name>`) inside an appassets card src. */
internal fun relOf(src: String): String = src.substringAfter("/${Attachments.DIR}/", "")

/** Extract the design cards from one message's attachments - the ingest unit for the inbound
 * pipeline and the one-time dock backfill. Reads at most [maxFiles] html-looking attachments (a
 * bounded synchronous read on the drain thread); [readPrefix] returns a bounded head of an
 * attachment (the `@dsCard` marker leads the file) or null when unavailable. */
internal fun cardsFrom(
	files: List<MessageFile>,
	at: Long,
	maxFiles: Int = 4,
	readPrefix: (rel: String) -> String?,
): List<StoredCard> {
	val out = mutableListOf<StoredCard>()
	var scanned = 0
	for (f in files) {
		val src = f.src ?: continue
		if (!looksHtml(f.mime, f.name)) continue
		if (scanned >= maxFiles) break
		scanned++
		val rel = relOf(src)
		val html = readPrefix(rel) ?: continue
		val meta = parseDsCardMarker(html) ?: continue
		out.add(StoredCard(f.name, rel, at, htmlTitle(html), meta.group, meta.width, meta.height))
	}
	return out
}
