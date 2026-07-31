package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/**
 * One attachment as the two renderers should show it. The transcript runs in a WebView and the
 * composer in Compose, so they cannot share a component, but every DECISION about what to show is
 * made here and consumed by both. That split is where the three surfaces drifted apart.
 */
data class DisplayAttachment(
	val file: MessageFile,
	val decoration: ChipDecoration?,
	/** Rendered as a thumbnail with no filename, rather than as a named row. */
	val previewable: Boolean,
)

////////////////////////////////
//  Functions & Helpers

/**
 * Mime types a thumbnail surface can actually draw.
 *
 * An allowlist rather than an `image/` prefix test, because a prefix promotes anything the sender
 * labels as an image into the thumbnail path, where a format the renderer cannot decode shows a
 * broken tile instead of a readable file row. TIFF and HEIC are the live examples: the WebView
 * decodes neither, so they belong with files despite being images.
 *
 * Video is absent on purpose. It is previewable in principle, but nothing generates poster frames
 * yet, so promoting it now would draw an empty tile. SVG is absent for the opposite reason: the
 * WebView draws it fine, but the fullscreen viewer decodes with BitmapFactory, which cannot, so a
 * thumbnail would promise a tap that fails.
 */
private val PREVIEWABLE_MIMES = setOf(
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/bmp",
	"image/apng",
	"image/avif",
)

/** The role vocabulary this build understands. A value outside it was said DELIBERATELY by a
 * NEWER sender; absent (a pre-role row, or a stripping middle hop) means an ordinary attachment. */
private val KNOWN_ROLES = setOf("attachment", "ref-snapshot", "design-card")

private fun unrecognizedRole(file: MessageFile): Boolean = file.role != null && file.role !in KNOWN_ROLES

/** An ordinary attachment: absent role or the explicit value. Machinery and unknown roles are not,
 * however drawable their bytes happen to be. */
private fun ordinaryRole(file: MessageFile): Boolean = file.role == null || file.role == "attachment"

/** A thumbnail needs a drawable format, bytes to draw, and an ordinary role: a file whose declared
 * role this build does not recognize renders as a plain named row, never a thumbnail - the unknown
 * signal is spent on RANKING, not reachability, so a wrong guess is a demoted row rather than an
 * unreachable file. */
internal fun isPreviewable(file: MessageFile): Boolean =
	file.src != null && ordinaryRole(file) && file.mime.substringBefore(';').trim().lowercase() in PREVIEWABLE_MIMES

/**
 * The attachments to show, in the order to show them: previewables first as thumbnails, then files
 * as rows, with UNRECOGNIZED-role files last so future machinery can never crowd out what the user
 * actually attached (a known role keeps its sent position - it is machinery this build understands,
 * not a stranger). Plugin-hidden entries are dropped before anything else, since an attachment a
 * plugin already surfaces another way should not be counted, ordered, or rendered at all.
 *
 * Stable within each group, so files keep the order they were sent in.
 */
internal fun displayAttachments(
	files: List<MessageFile>,
	decorate: (MessageFile) -> ChipDecoration?,
): List<DisplayAttachment> =
	files
		.mapNotNull { f ->
			val d = decorate(f)
			if (d?.hidden == true) null else DisplayAttachment(f, d, isPreviewable(f))
		}
		.sortedWith(compareByDescending<DisplayAttachment> { it.previewable }.thenBy { unrecognizedRole(it.file) })

/** What to label an attachment with. A decoration's title replaces the filename outright, which is
 * how a plugin presents an attachment as the thing it means rather than the file it is. */
internal fun displayName(item: DisplayAttachment): String {
	val title = item.decoration?.title
	if (!title.isNullOrBlank()) return title
	return item.file.name.ifBlank { "file" }
}

/** Decimal units, matching what a file manager shows, so a size here agrees with the one the user
 * sees after saving. Null when the size was never carried, which a row hides rather than showing
 * as zero. */
internal fun prettySize(bytes: Long?): String? {
	if (bytes == null || bytes < 0) return null
	// The tier is picked from the ROUNDED value, not the raw bytes: choosing on raw bytes and then
	// rounding the quotient prints "1000 KB" for anything just under a megabyte.
	val kb = Math.round(bytes / 1_000.0)
	return when {
		bytes >= 1_000_000 || kb >= 1_000 -> "%.1f MB".format(bytes / 1_000_000.0)
		bytes >= 1_000 -> "$kb KB"
		else -> "$bytes B"
	}
}
