package com.atelier_nyaarium.switchboard.plugins.designer

import com.atelier_nyaarium.switchboard.Attachments
import java.io.File

////////////////////////////////
//  Functions & Helpers

/** The most a card's HTML may be to render. Shared so the chip opener refuses to CLAIM anything the
 * viewer would then refuse to render, which would swallow the tap. A card is small by contract (the
 * mockup corpus is ~10 KB each); an oversize one keeps its dock entry and renders as unavailable. */
internal const val CARD_RENDER_CAP_BYTES: Long = 4L * 1024 * 1024

/** Bytes read to detect a card: the `@dsCard` marker and `<title>` both lead the file (head), so a
 * small prefix suffices. Bounded so ingest (poll thread) and a chip tap (UI thread) never read a
 * whole file just to classify it. */
private const val CARD_MARKER_PREFIX_BYTES = 8 * 1024

/** A bounded prefix of a card's HTML through the attachment path-safety gate, or null when the file
 * is gone, oversize (too big to ever render, so never gallery'd), or unreadable. Enough to parse the
 * marker + title on both the ingest path and a chip tap without reading the whole file. */
internal fun readCardPrefix(filesDir: File, rel: String, cap: Int = CARD_MARKER_PREFIX_BYTES): String? {
	if (rel.isEmpty()) return null
	val file = Attachments.resolve(filesDir, rel) ?: return null
	if (file.length() > CARD_RENDER_CAP_BYTES) return null
	return runCatching { file.inputStream().use { String(it.readNBytes(cap), Charsets.UTF_8) } }.getOrNull()
}

/** A card's full HTML for rendering (the viewer), or null when gone, oversize, or unreadable. Capped
 * by contract: a card is small (the mockup corpus is ~10 KB each). */
internal fun readCardHtml(filesDir: File, rel: String): String? {
	if (rel.isEmpty()) return null
	val file = Attachments.resolve(filesDir, rel) ?: return null
	if (file.length() > CARD_RENDER_CAP_BYTES) {
		com.atelier_nyaarium.switchboard.DebugLog.log("Designer", "card ${file.name} is ${file.length()}B > ${CARD_RENDER_CAP_BYTES}B cap; not rendered")
		return null
	}
	return runCatching { file.readText() }.getOrNull()
}

/** Resolve an attachment-relative path to a File before acting on it. */
internal fun cardFile(filesDir: File, rel: String): File? = Attachments.resolve(filesDir, rel)

/** Build a standalone card for an EXACT tapped attachment (chip-open), independent of the dock
 * gallery - so an older revision, or a canvas deleted from the dock, still opens the file tapped. */
internal fun buildCardForRel(filesDir: File, rel: String): DesignerCard? {
	val html = readCardHtml(filesDir, rel) ?: return null
	val meta = parseDsCardMarker(html) ?: return null
	val name = rel.substringAfterLast('/')
	return DesignerCard(name, htmlTitle(html) ?: name.substringBeforeLast('.'), rel, 0L, meta)
}
