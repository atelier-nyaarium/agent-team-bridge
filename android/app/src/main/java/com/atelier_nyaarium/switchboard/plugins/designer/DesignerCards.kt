package com.atelier_nyaarium.switchboard.plugins.designer

import com.atelier_nyaarium.switchboard.Message

/** Attributes parsed off a card's `@dsCard` marker. `width`/`height` are the author's intended
 * viewport (display hints only); `group` is the kit section label. */
data class DsCardMeta(
	val group: String = "",
	val width: Int? = null,
	val height: Int? = null,
)

/** One design canvas in a conversation's dock, derived from an attachment. */
data class DesignerCard(
	/** Display name: the HTML `<title>`, else the filename stem. */
	val name: String,
	/** The attachment filename - the card's IDENTITY. A later push with the same filename
	 * updates the card in place (DesignSync's register/update semantics without a wire op). */
	val fileName: String,
	/** The materialized attachment's renderer URL (`https://appassets...`), used to locate the
	 * on-disk HTML for the sandboxed render. */
	val src: String,
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

/**
 * Derive a conversation's design cards from its messages - the card index is a VIEW over thread
 * state, never a second persisted copy (so `forget()`, schema wipes, and attachment eviction can
 * not leave a stale index behind; see plans/plugins.md). An attachment is a card when it is an
 * HTML file whose content leads with the `@dsCard` marker. Cards keep first-appearance order; a
 * same-filename card from a message with an equal-or-later timestamp updates in place.
 *
 * PEER-MIRROR ROWS ARE EXCLUDED. A `kind:"peer"` row is an agent-to-agent exchange mirrored into
 * this thread (`Message.isPeer`, `from`/`to` are the real two parties, neither necessarily the
 * human); its attachments belong to that OTHER exchange. Folding them in by filename would let a
 * card from an unrelated exchange seed or silently overwrite a card the human's own agent pushed
 * to THIS thread (same collision the renderer disambiguates with a "from -> to" label). The dock
 * shows only cards delivered on this conversation's own channel.
 *
 * [readHtml] resolves an attachment src to its text (injected: the app reads the materialized
 * file, tests read fixtures); an unresolvable attachment is simply not a card.
 */
fun designerCards(messages: List<Message>, readHtml: (src: String) -> String?): List<DesignerCard> {
	val byFile = LinkedHashMap<String, DesignerCard>()
	for (msg in messages) {
		if (msg.isPeer) continue
		for (f in msg.files) {
			val src = f.src ?: continue
			val looksHtml = f.mime.startsWith("text/html") ||
				f.name.endsWith(".html", ignoreCase = true) ||
				f.name.endsWith(".htm", ignoreCase = true)
			if (!looksHtml) continue
			val html = readHtml(src) ?: continue
			val meta = parseDsCardMarker(html) ?: continue
			val existing = byFile[f.name]
			if (existing != null && msg.at < existing.updatedAt) continue
			val stem = f.name.substringBeforeLast('.')
			// A LinkedHashMap put on an existing key keeps its position: update-in-place.
			byFile[f.name] = DesignerCard(
				name = htmlTitle(html) ?: stem,
				fileName = f.name,
				src = src,
				updatedAt = msg.at,
				meta = meta,
			)
		}
	}
	return byFile.values.toList()
}
