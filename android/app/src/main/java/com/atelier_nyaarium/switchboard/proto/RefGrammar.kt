package com.atelier_nyaarium.switchboard.proto

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Hand-authored twin of `src/mcp/references/refLexer.ts` + `refGrammar.ts`.
 *
 * The MCP writes canonical ref keys into a message's manifest; this side recomputes a key from a
 * tapped link and looks it up. If the two ever disagree on one character, every tap on that ref
 * misses and nothing reports why, so the twin is held to the TS source by the shared vector corpus
 * (`tests/fixtures/refs/vectors.json`, read by `RefGrammarVectorsTest` and by vitest).
 *
 * Two lexing modes, five token kinds, and one ambiguity rule: the first structural marker by
 * position wins and everything after it is ordinary text. The full spec lives in
 * `plans/artifact-references.md`.
 */
sealed class Matcher {
	data class Text(val text: String) : Matcher()

	data class Before(val text: String, val anchor: String) : Matcher()

	data class After(val text: String, val anchor: String) : Matcher()

	data class Range(val from: String, val to: String) : Matcher()
}

data class Ref(val path: String, val segments: List<String>, val matcher: Matcher?)

sealed class RefParseResult {
	data class Ok(val ref: Ref) : RefParseResult()

	object NotARef : RefParseResult()

	/** `code` matches the TS `ParseErrorCode` union exactly; the vectors pin both it and the offset. */
	data class Error(val code: String, val offset: Int) : RefParseResult()
}

const val REF_SCHEME = "ref://"

private enum class Kind { SEP, HASH, RANGE, AT, CHAR }

private data class Token(val kind: Kind, val value: String, val offset: Int)

private val ANCHOR_KEYWORDS = listOf("before", "after")

// Derived from what the reader treats specially in each mode, never hand-kept: that mode's
// structural characters, `%` because it introduces an escape, and `<`/`>` plus whitespace because
// the parser strips those before lexing.
private val SCOPE_ESCAPES = setOf('%', ':', '#', '<', '>')
private val FRAGMENT_ESCAPES = setOf('%', ':', '#', '.', '@', '<', '>')

private fun isHex(c: Char) = c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'

/**
 * Decode a run of `%XX` escapes as one unit, or null if the bytes are not valid UTF-8.
 *
 * REPORT rather than the platform default: a plain `String(bytes, UTF_8)` substitutes U+FFFD and
 * succeeds, where the TS side's `decodeURIComponent` throws and falls back to literal text. Matching
 * that requires asking the decoder to fail.
 */
private fun decodeEscapeRun(bytes: ByteArray): String? {
	val decoder = Charsets.UTF_8.newDecoder()
		.onMalformedInput(CodingErrorAction.REPORT)
		.onUnmappableCharacter(CodingErrorAction.REPORT)
	return try {
		decoder.decode(ByteBuffer.wrap(bytes)).toString()
	} catch (_: CharacterCodingException) {
		null
	}
}

/** Every code point of `s`, so an astral character is one unit rather than two surrogates. */
private fun codePoints(s: String): List<String> {
	val out = ArrayList<String>(s.length)
	var i = 0
	while (i < s.length) {
		val cp = s.codePointAt(i)
		val width = Character.charCount(cp)
		out.add(s.substring(i, i + width))
		i += width
	}
	return out
}

private fun lex(input: String): List<Token> {
	val tokens = ArrayList<Token>()
	var fragment = false
	var i = 0

	while (i < input.length) {
		val c = input[i]

		if (c == '%') {
			var end = i
			val bytes = ArrayList<Byte>()
			while (end + 2 < input.length && input[end] == '%' && isHex(input[end + 1]) && isHex(input[end + 2])) {
				bytes.add(input.substring(end + 1, end + 3).toInt(16).toByte())
				end += 3
			}
			val decoded = if (bytes.isEmpty()) null else decodeEscapeRun(bytes.toByteArray())
			if (decoded != null) {
				for (unit in codePoints(decoded)) tokens.add(Token(Kind.CHAR, unit, i))
				i = end
				continue
			}
			tokens.add(Token(Kind.CHAR, "%", i))
			i++
			continue
		}

		if (c == ':') {
			tokens.add(Token(Kind.SEP, "", i))
			i++
			continue
		}

		if (c == '#' && !fragment) {
			tokens.add(Token(Kind.HASH, "", i))
			fragment = true
			i++
			continue
		}

		if (fragment && c == '@') {
			tokens.add(Token(Kind.AT, "", i))
			i++
			continue
		}

		if (fragment && c == '.') {
			var run = i
			while (run < input.length && input[run] == '.') run++
			val length = run - i
			// Exactly two dots is a range. Three or more is a spread or a variadic, so `#...args`
			// searches for that text instead of parsing as a broken range.
			if (length == 2) {
				tokens.add(Token(Kind.RANGE, "", i))
			} else {
				for (n in 0 until length) tokens.add(Token(Kind.CHAR, ".", i + n))
			}
			i = run
			continue
		}

		// Advance by code point so an astral character stays one token, matching the JS iterator.
		val cp = input.codePointAt(i)
		val width = Character.charCount(cp)
		tokens.add(Token(Kind.CHAR, input.substring(i, i + width), i))
		i += width
	}

	return tokens
}

private fun tokenText(token: Token): String =
	when (token.kind) {
		Kind.SEP -> ":"
		Kind.HASH -> "#"
		Kind.RANGE -> ".."
		Kind.AT -> "@"
		Kind.CHAR -> token.value
	}

private fun tokensToText(tokens: List<Token>): String = tokens.joinToString("") { tokenText(it) }

private data class Anchor(val at: Int, val keyword: String, val after: Int)

/** Where an anchor marker starts, or null. Only `@` + exactly `before`/`after` + `:` is structural,
 * so an at-sign in an email address needs no encoding. */
private fun findAnchor(tokens: List<Token>): Anchor? {
	for (i in tokens.indices) {
		if (tokens[i].kind != Kind.AT) continue
		for (keyword in ANCHOR_KEYWORDS) {
			val end = i + 1 + keyword.length
			if (end >= tokens.size || tokens[end].kind != Kind.SEP) continue
			val spelled = tokens.subList(i + 1, end).joinToString("") { if (it.kind == Kind.CHAR) it.value else "" }
			if (spelled == keyword) return Anchor(i, keyword, end + 1)
		}
	}
	return null
}

private sealed class MatcherResult {
	data class Parsed(val matcher: Matcher) : MatcherResult()

	data class Failed(val code: String, val offset: Int) : MatcherResult()
}

private fun parseMatcher(tokens: List<Token>, hashOffset: Int): MatcherResult {
	if (tokens.isEmpty()) return MatcherResult.Failed("empty-fragment", hashOffset)

	val anchor = findAnchor(tokens)
	val rangeAt = tokens.indexOfFirst { it.kind == Kind.RANGE }

	if (anchor != null && (rangeAt == -1 || anchor.at < rangeAt)) {
		val text = tokensToText(tokens.subList(0, anchor.at))
		val anchorText = tokensToText(tokens.subList(anchor.after, tokens.size))
		if (text.isEmpty()) return MatcherResult.Failed("empty-match-text", tokens[0].offset)
		if (anchorText.isEmpty()) return MatcherResult.Failed("empty-anchor", tokens[anchor.at].offset)
		return MatcherResult.Parsed(
			if (anchor.keyword == "before") Matcher.Before(text, anchorText) else Matcher.After(text, anchorText),
		)
	}

	if (rangeAt != -1) {
		val from = tokensToText(tokens.subList(0, rangeAt))
		val to = tokensToText(tokens.subList(rangeAt + 1, tokens.size))
		if (from.isEmpty() || to.isEmpty()) return MatcherResult.Failed("empty-range-bound", tokens[rangeAt].offset)
		return MatcherResult.Parsed(Matcher.Range(from, to))
	}

	return MatcherResult.Parsed(Matcher.Text(tokensToText(tokens)))
}

fun tryParseRef(uri: String): RefParseResult {
	// The angle-bracket pair is markdown's destination wrapper, so it comes off only as a PAIR.
	// Stripping a lone trailing one would silently shorten `#Promise<Response>`.
	val bare = uri.trim()
	val wrapped = bare.length >= 2 && bare.startsWith("<") && bare.endsWith(">")
	val unwrapped = if (wrapped) bare.substring(1, bare.length - 1) else bare
	if (!unwrapped.lowercase().startsWith(REF_SCHEME)) return RefParseResult.NotARef

	// Offsets are shifted past the scheme so they index the ref as WRITTEN, matching the TS side and
	// the shared vectors: an error message quotes the whole ref, so a raw lexer offset points short.
	val tokens = lex(unwrapped.substring(REF_SCHEME.length)).map { it.copy(offset = it.offset + REF_SCHEME.length) }
	val hashAt = tokens.indexOfFirst { it.kind == Kind.HASH }
	val scope = if (hashAt == -1) tokens else tokens.subList(0, hashAt)

	// path := char+. Required, which is what stops `ref://:Foo` from quietly promoting its first
	// segment into the path slot.
	val firstSep = scope.indexOfFirst { it.kind == Kind.SEP }
	val pathTokens = if (firstSep == -1) scope else scope.subList(0, firstSep)
	if (pathTokens.isEmpty()) return RefParseResult.Error("path-required", 0)

	// segment := char*, so an empty one merges. That IS the `::` collapse, stated rather than falling
	// out of a filter as a side effect.
	val segments = ArrayList<String>()
	var cursor = firstSep
	while (cursor != -1) {
		var nextSep = -1
		for (i in cursor + 1 until scope.size) {
			if (scope[i].kind == Kind.SEP) {
				nextSep = i
				break
			}
		}
		val text = tokensToText(scope.subList(cursor + 1, if (nextSep == -1) scope.size else nextSep))
		if (text.isNotEmpty()) segments.add(text)
		cursor = nextSep
	}

	val path = tokensToText(pathTokens)
	if (hashAt == -1) return RefParseResult.Ok(Ref(path, segments, null))

	return when (val matcher = parseMatcher(tokens.subList(hashAt + 1, tokens.size), tokens[hashAt].offset)) {
		is MatcherResult.Failed -> RefParseResult.Error(matcher.code, matcher.offset)
		is MatcherResult.Parsed -> RefParseResult.Ok(Ref(path, segments, matcher.matcher))
	}
}

fun parseRef(uri: String): Ref? = (tryParseRef(uri) as? RefParseResult.Ok)?.ref

private fun escapeCodePoint(unit: String): String =
	unit.toByteArray(Charsets.UTF_8).joinToString("") { "%%%02X".format(it.toInt() and 0xFF) }

private fun encode(raw: String, escapes: Set<Char>): String {
	val out = StringBuilder()
	for (unit in codePoints(raw)) {
		val single = unit.length == 1 && (unit[0] in escapes || unit[0].isWhitespace())
		out.append(if (single) escapeCodePoint(unit) else unit)
	}
	return out.toString()
}

private fun serializeMatcher(matcher: Matcher): String {
	fun text(raw: String) = encode(raw, FRAGMENT_ESCAPES)
	return when (matcher) {
		is Matcher.Text -> "#${text(matcher.text)}"
		is Matcher.Before -> "#${text(matcher.text)}@before:${text(matcher.anchor)}"
		is Matcher.After -> "#${text(matcher.text)}@after:${text(matcher.anchor)}"
		is Matcher.Range -> "#${text(matcher.from)}..${text(matcher.to)}"
	}
}

/**
 * The stable identity of a ref, byte-identical to the MCP's `canonicalKey`.
 *
 * Idempotent by construction: every character the reader treats specially is escaped, so re-reading
 * a key yields the same tokens and therefore the same ref.
 */
fun canonicalKey(ref: Ref): String {
	val scope = (listOf(ref.path) + ref.segments).joinToString(":") { encode(it, SCOPE_ESCAPES) }
	return "$REF_SCHEME$scope${ref.matcher?.let { serializeMatcher(it) } ?: ""}"
}

/** Canonicalize a tapped link destination for manifest lookup, or null if it is not a ref. */
fun canonicalizeRefUri(uri: String): String? = parseRef(uri)?.let { canonicalKey(it) }
