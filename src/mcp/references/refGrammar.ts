import { lex, type Token, tokensToText } from "./refLexer.js";

////////////////////////////////
//  Interfaces & Types

/**
 * What a ref's fragment selects inside the innermost resolved scope. The anchor and range forms are
 * W3C Text Fragment semantics under a cleaner spelling, with one deliberate deviation: the spec
 * anchors on immediate adjacency, while `@before`/`@after` here mean nearest-in-scope, which is
 * what someone pointing at the third `foo += 1` in a repetitive function actually means.
 */
export type Matcher =
	| { kind: "text"; text: string }
	| { kind: "before"; text: string; anchor: string }
	| { kind: "after"; text: string; anchor: string }
	| { kind: "range"; from: string; to: string };

/** A parsed ref. Every string here is DECODED; re-encoding happens only in `canonicalKey`. */
export interface Ref {
	/** Project-relative, as written. Confinement is the resolver's job, not the parser's. */
	path: string;
	/** Scope waypoints. Each matches any descendant of the previous, not only a direct child. */
	segments: string[];
	matcher: Matcher | null;
}

export type ParseErrorCode =
	| "path-required"
	| "empty-fragment"
	| "empty-match-text"
	| "empty-anchor"
	| "empty-range-bound";

/**
 * Parsing is TOTAL: an input is a ref, is not one at all, or is a stated error at a stated offset.
 * There is no fourth outcome where a malformed ref silently becomes a different valid ref, which is
 * the failure this grammar exists to make unrepresentable.
 */
export type ParseResult =
	| { kind: "ok"; ref: Ref }
	| { kind: "not-a-ref" }
	| { kind: "error"; code: ParseErrorCode; message: string; offset: number };

////////////////////////////////
//  Functions & Helpers

export const REF_SCHEME = "ref://";

const ANCHOR_KEYWORDS = ["before", "after"] as const;

type AnchorKeyword = (typeof ANCHOR_KEYWORDS)[number];

/**
 * Characters the printer escapes, per lexing mode.
 *
 * Derived from what the reader treats specially rather than hand-maintained: that mode's structural
 * tokens, `%` because it introduces an escape, and `<`/`>`/whitespace because `tryParseRef` strips
 * those before lexing. A hand-kept list can drift from what the reader actually treats specially;
 * deriving it here keeps the two in sync.
 */
const SCOPE_ESCAPES = new Set(["%", ":", "#", "<", ">"]);
const FRAGMENT_ESCAPES = new Set(["%", ":", "#", ".", "@", "<", ">"]);

function escapeChar(c: string): string {
	return [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

function encode(raw: string, escapes: Set<string>): string {
	let out = "";
	for (const c of raw) out += escapes.has(c) || /\s/.test(c) ? escapeChar(c) : c;
	return out;
}

function error(code: ParseErrorCode, message: string, offset: number): ParseResult {
	return { kind: "error", code, message, offset };
}

/** Where an anchor marker (`@before:` / `@after:`) starts, or null. Only that exact shape is
 * structural, so an `@` in an email address needs no encoding. */
function findAnchor(tokens: Token[]): { at: number; keyword: AnchorKeyword; after: number } | null {
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].kind !== "at") continue;
		for (const keyword of ANCHOR_KEYWORDS) {
			const end = i + 1 + keyword.length;
			if (tokens[end]?.kind !== "sep") continue;
			const spelled = tokens
				.slice(i + 1, end)
				.map((t) => (t.kind === "char" ? t.value : ""))
				.join("");
			if (spelled === keyword) return { at: i, keyword, after: end + 1 };
		}
	}
	return null;
}

type MatcherResult = ParseResult | { kind: "matcher"; matcher: Matcher };

/**
 * Parse a fragment.
 *
 * One rule resolves every ambiguity: the FIRST structural marker by position wins, and everything
 * after it is ordinary text. That is why a second `@after:` or a second `..` needs no encoding to be
 * searched for literally, and why which form a fragment takes never depends on the order these
 * branches happen to be written in.
 */
function parseMatcher(tokens: Token[], hashOffset: number): MatcherResult {
	if (tokens.length === 0) {
		return error("empty-fragment", "a `#` with nothing after it selects nothing", hashOffset);
	}

	const anchor = findAnchor(tokens);
	const rangeAt = tokens.findIndex((t) => t.kind === "range");

	if (anchor && (rangeAt === -1 || anchor.at < rangeAt)) {
		const text = tokensToText(tokens.slice(0, anchor.at));
		const anchorText = tokensToText(tokens.slice(anchor.after));
		if (text === "") {
			return error("empty-match-text", "nothing to search for before the anchor", tokens[0].offset);
		}
		if (anchorText === "") {
			return error(
				"empty-anchor",
				`\`@${anchor.keyword}:\` needs text to anchor against`,
				tokens[anchor.at].offset,
			);
		}
		return { kind: "matcher", matcher: { kind: anchor.keyword, text, anchor: anchorText } };
	}

	if (rangeAt !== -1) {
		const from = tokensToText(tokens.slice(0, rangeAt));
		const to = tokensToText(tokens.slice(rangeAt + 1));
		if (from === "" || to === "") {
			return error("empty-range-bound", "a range needs text on both sides of `..`", tokens[rangeAt].offset);
		}
		return { kind: "matcher", matcher: { kind: "range", from, to } };
	}

	return { kind: "matcher", matcher: { kind: "text", text: tokensToText(tokens) } };
}

/**
 * Parse a `ref://` URI.
 *
 * Deliberately not `new URL()`: under URL rules `ref://app.js:Foo` reads `app.js` as a host and
 * `:Foo` as a port, which is not what any of this means.
 */
export function tryParseRef(uri: string): ParseResult {
	// The angle-bracket pair is markdown's destination wrapper, so it comes off only as a PAIR.
	// Stripping a lone trailing one would silently shorten `#Promise<Response>`.
	const bare = uri.trim();
	const wrapped = bare.length >= 2 && bare.startsWith("<") && bare.endsWith(">");
	const unwrapped = wrapped ? bare.slice(1, -1) : bare;
	if (!unwrapped.toLowerCase().startsWith(REF_SCHEME)) return { kind: "not-a-ref" };

	// Offsets are shifted past the scheme so they index the ref as WRITTEN, which is the string an
	// error message quotes back. A raw lexer offset would point six characters short of the problem.
	const tokens = lex(unwrapped.slice(REF_SCHEME.length)).map((t) => ({ ...t, offset: t.offset + REF_SCHEME.length }));
	const hashAt = tokens.findIndex((t) => t.kind === "hash");
	const scope = hashAt === -1 ? tokens : tokens.slice(0, hashAt);

	// path := char+. Required, which is what stops `ref://:Foo` from quietly promoting its first
	// segment into the path slot; a filter over split pieces cannot tell that apart from a `::` merge.
	const firstSep = scope.findIndex((t) => t.kind === "sep");
	const pathTokens = firstSep === -1 ? scope : scope.slice(0, firstSep);
	if (pathTokens.length === 0) {
		return error("path-required", "a ref needs a file path before any `:`", 0);
	}

	// segment := char*, so an empty one merges. That IS the `::` collapse, stated rather than
	// falling out of a filter as a side effect.
	const segments: string[] = [];
	let cursor = firstSep;
	while (cursor !== -1) {
		const nextSep = scope.findIndex((t, i) => i > cursor && t.kind === "sep");
		const text = tokensToText(scope.slice(cursor + 1, nextSep === -1 ? scope.length : nextSep));
		if (text !== "") segments.push(text);
		cursor = nextSep;
	}

	const ref: Ref = { path: tokensToText(pathTokens), segments, matcher: null };
	if (hashAt === -1) return { kind: "ok", ref };

	const matcher = parseMatcher(tokens.slice(hashAt + 1), tokens[hashAt].offset);
	if (matcher.kind !== "matcher") return matcher;
	return { kind: "ok", ref: { ...ref, matcher: matcher.matcher } };
}

/** The parsed ref, or null for anything that is not a well-formed one. A caller that needs to tell
 * an agent WHY its ref was rejected uses `tryParseRef`. */
export function parseRef(uri: string): Ref | null {
	const result = tryParseRef(uri);
	return result.kind === "ok" ? result.ref : null;
}

function serializeMatcher(matcher: Matcher): string {
	const text = (raw: string) => encode(raw, FRAGMENT_ESCAPES);
	switch (matcher.kind) {
		case "text":
			return `#${text(matcher.text)}`;
		case "before":
		case "after":
			return `#${text(matcher.text)}@${matcher.kind}:${text(matcher.anchor)}`;
		case "range":
			return `#${text(matcher.from)}..${text(matcher.to)}`;
	}
}

/**
 * The stable identity of a ref: what the MCP writes as a manifest key and what the console
 * recomputes from a tapped link.
 *
 * Idempotent by construction rather than by remembering: every character the reader treats
 * specially is escaped, so re-reading a key yields the same tokens and therefore the same ref.
 */
export function canonicalKey(ref: Ref): string {
	const scope = [ref.path, ...ref.segments].map((c) => encode(c, SCOPE_ESCAPES)).join(":");
	return `${REF_SCHEME}${scope}${ref.matcher ? serializeMatcher(ref.matcher) : ""}`;
}

/** Parse and canonicalize in one step, or null if the input is not a well-formed ref. */
export function canonicalizeUri(uri: string): string | null {
	const ref = parseRef(uri);
	return ref ? canonicalKey(ref) : null;
}
