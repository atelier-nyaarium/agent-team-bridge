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
	/** Display name: the wire-declared title, else the filename stem. */
	val name: String,
	/** The attachment-relative path (`<bucket>/<name>`) of the latest push, for rendering + actions.
	 * Null while the bytes are still in flight (or failed): the card exists the moment its message
	 * arrives, and the stage says downloading rather than the card silently not existing. */
	val rel: String?,
	val updatedAt: Long,
	val meta: DsCardMeta,
	/** Names the bytes for the retry path while [rel] is null. */
	val blobId: String? = null,
	/** The fetch gave up (bounded tries). Distinguishes "arriving" from "will never arrive". */
	val fetchFailed: Boolean = false,
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
internal fun relOf(src: String): String = Attachments.relOf(src).orEmpty()

/** The landed rel for a stored card, from the live thread rows, newest first. Content-keyed: the
 * row file naming the card's own bytes is the one whose src counts, so an older revision under the
 * same filename can never lend its bytes to the current card. Null while nothing has landed. */
internal fun resolveCardRel(rows: List<com.atelier_nyaarium.switchboard.Message>, card: StoredCard): String? {
	val blobId = card.blobId ?: return null
	for (i in rows.indices.reversed()) {
		for (f in rows[i].files) {
			if (f.blobId == blobId) {
				f.src?.let(::relOf)?.takeIf { it.isNotEmpty() }?.let { return it }
			}
		}
	}
	return null
}

/** A message file's stored-card form, from its wire-declared fields alone. Zero disk, zero timing:
 * the card is real the instant its message is, and the rel fills in whenever the bytes have landed
 * (which may be now, later, or never). */
internal fun storedCardFrom(f: MessageFile, at: Long): StoredCard? {
	if (f.role != "design-card") return null
	return StoredCard(
		fileName = f.name,
		rel = f.src?.let(::relOf)?.takeIf { it.isNotEmpty() },
		at = at,
		title = f.cardTitle,
		group = f.cardGroup ?: "",
		w = f.cardWidth?.toInt(),
		h = f.cardHeight?.toInt(),
		blobId = f.blobId,
	)
}
