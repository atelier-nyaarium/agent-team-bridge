package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Terminal selection to a link
//
//  Pure (no Compose, no Android), JVM-testable. The pane hands a raw selection over; what comes
//  back is the link the owner was reaching for, or null for everything else.

/** Schemes that carry no `//`. A custom app scheme is never one of these, which is what stops a
 * bare `TODO:fix` from being offered as a link. */
private val SLASHLESS_SCHEMES = setOf("mailto", "tel", "sms", "geo")

private val SCHEME_HEAD = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

/**
 * The link a terminal selection resolves to, or null when it is not one.
 *
 * A pane is a fixed grid, so a link longer than a row is split across rows and each continuation
 * carries whatever indent the TUI drew around it. Both are the pane speaking rather than the link,
 * so both come off and the rows are joined. The answer is only offered when what survives is one
 * whitespace-free URL carrying a scheme: the rewrite has to still look like a link, or every caller
 * falls back to the selection exactly as it was made.
 */
internal fun selectedUrl(selected: String): String? {
	val trimmed = selected.trim()
	if (trimmed.isEmpty() || !SCHEME_HEAD.containsMatchIn(trimmed)) return null

	val rows = trimmed.lines()
	// A blank row is a break the content asked for, never one the pane forced, so it disqualifies.
	if (rows.any { it.isBlank() }) return null

	val joined = rows.joinToString("") { it.trim() }
	if (joined.any { it.isWhitespace() } || !SCHEME_HEAD.containsMatchIn(joined)) return null

	val scheme = joined.substringBefore(":").lowercase()
	if (!joined.startsWith("$scheme://", ignoreCase = true) && scheme !in SLASHLESS_SCHEMES) return null

	return if (joined.substringAfter(":").removePrefix("//").isEmpty()) null else joined
}

/** What the open button calls a link: its host, falling back to the scheme for one that has none. */
internal fun linkLabel(url: String): String {
	val scheme = url.substringBefore(":", "")
	val host = url.substringAfter("://", "").substringBefore("/").substringBefore("?").substringBefore("#")
	return host.ifEmpty { "$scheme:" }
}
