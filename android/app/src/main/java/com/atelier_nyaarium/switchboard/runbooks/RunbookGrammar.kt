package com.atelier_nyaarium.switchboard.runbooks

/**
 * The twin of `placeholdersOf` in `src/shared/runbook-grammar.ts`, pinned by
 * `tests/fixtures/runbook-grammar/vectors.json`. Recognition only: a render must be the gateway's
 * own, or a preview would not match what a fire sends.
 */
// Explicit whitespace, never `\s`: the two runtimes disagree about which characters it covers.
private val PLACEHOLDER_AT = Regex("""^\{\{[ \t\r\n]*([A-Za-z][A-Za-z0-9_]*)[ \t\r\n]*}}""")

/** Null when an opener names no parameter, which the gateway refuses outright. */
fun placeholdersOf(body: String): List<String>? {
	val names = LinkedHashSet<String>()
	var at = 0
	while (at < body.length) {
		val open = body.indexOf("{{", at)
		if (open < 0) return names.toList()
		val match = PLACEHOLDER_AT.find(body.substring(open)) ?: return null
		names += match.groupValues[1]
		at = open + match.value.length
	}
	return names.toList()
}
