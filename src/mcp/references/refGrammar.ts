import { lex, type Token, tokensToText } from "./refLexer.js";

////////////////////////////////
//  Interfaces & Types

/** W3C Text Fragment semantics, with one deviation: `@before`/`@after` mean nearest-in-scope, not
 * the spec's immediate adjacency. */
export type Matcher =
	| { kind: "text"; text: string }
	| { kind: "before"; text: string; anchor: string }
	| { kind: "after"; text: string; anchor: string }
	| { kind: "range"; from: string; to: string };

/** Every string here is DECODED; only `canonicalKey` re-encodes. */
export interface Ref {
	/** As written. Confinement is the resolver's job. */
	path: string;
	/** Each matches any descendant of the previous, not only a direct child. */
	segments: string[];
	matcher: Matcher | null;
}

export type ParseErrorCode =
	| "path-required"
	| "empty-fragment"
	| "empty-match-text"
	| "empty-anchor"
	| "empty-range-bound";

/** Parsing is TOTAL: a ref, not a ref, or a stated error at a stated offset. There is no outcome
 * where a malformed ref silently becomes a different valid one. */
export type ParseResult =
	| { kind: "ok"; ref: Ref }
	| { kind: "not-a-ref" }
	| { kind: "error"; code: ParseErrorCode; message: string; offset: number };

////////////////////////////////
//  Functions & Helpers

export const REF_SCHEME = "ref://";

const ANCHOR_KEYWORDS = ["before", "after"] as const;

type AnchorKeyword = (typeof ANCHOR_KEYWORDS)[number];

// What the reader treats specially: structural tokens, `%`, and what tryParseRef strips.
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

/** Only that exact shape is structural, so an `@` in an email address needs no encoding. */
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

/** The FIRST structural marker by position wins and the rest is ordinary text, so a second `@after:`
 * needs no encoding and the form never depends on branch order. */
function parseMatcher(tokens: Token[], hashOffset: number): MatcherResult {
	if (tokens.length === 0) {
		return error("empty-fragment", `a \`#\` with nothing after it selects nothing`, hashOffset);
	}

	const anchor = findAnchor(tokens);
	const rangeAt = tokens.findIndex((t) => t.kind === "range");

	if (anchor && (rangeAt === -1 || anchor.at < rangeAt)) {
		const text = tokensToText(tokens.slice(0, anchor.at));
		const anchorText = tokensToText(tokens.slice(anchor.after));
		if (text === "") {
			return error("empty-match-text", `nothing to search for before the anchor`, tokens[0].offset);
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
			return error("empty-range-bound", `a range needs text on both sides of \`..\``, tokens[rangeAt].offset);
		}
		return { kind: "matcher", matcher: { kind: "range", from, to } };
	}

	return { kind: "matcher", matcher: { kind: "text", text: tokensToText(tokens) } };
}

/** Not `new URL()`: under URL rules `ref://app.js:Foo` reads `app.js` as a host and `:Foo` as a
 * port. */
export function tryParseRef(uri: string): ParseResult {
	// Markdown's wrapper comes off only as a PAIR, or `#Promise<Response>` silently shortens.
	const bare = uri.trim();
	const wrapped = bare.length >= 2 && bare.startsWith("<") && bare.endsWith(">");
	const unwrapped = wrapped ? bare.slice(1, -1) : bare;
	if (!unwrapped.toLowerCase().startsWith(REF_SCHEME)) return { kind: "not-a-ref" };

	// Shifted past the scheme, so an offset indexes the ref as WRITTEN.
	const tokens = lex(unwrapped.slice(REF_SCHEME.length)).map((t) => ({ ...t, offset: t.offset + REF_SCHEME.length }));
	const hashAt = tokens.findIndex((t) => t.kind === "hash");
	const scope = hashAt === -1 ? tokens : tokens.slice(0, hashAt);

	// path := char+, required, or `ref://:Foo` promotes its first segment into the path slot.
	const firstSep = scope.findIndex((t) => t.kind === "sep");
	const pathTokens = firstSep === -1 ? scope : scope.slice(0, firstSep);
	if (pathTokens.length === 0) {
		return error("path-required", `a ref needs a file path before any \`:\``, 0);
	}

	// segment := char*, so an empty one merges. That IS the `::` collapse.
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

/** Null for anything malformed. Use `tryParseRef` when the caller needs the reason. */
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

/** A ref's stable identity, which the console recomputes from a tapped link. Idempotent by
 * construction: everything the reader treats specially is escaped. */
export function canonicalKey(ref: Ref): string {
	const scope = [ref.path, ...ref.segments].map((c) => encode(c, SCOPE_ESCAPES)).join(":");
	return `${REF_SCHEME}${scope}${ref.matcher ? serializeMatcher(ref.matcher) : ""}`;
}

/** Parse and canonicalize in one step, or null if the input is not a well-formed ref. */
export function canonicalizeUri(uri: string): string | null {
	const ref = parseRef(uri);
	return ref ? canonicalKey(ref) : null;
}
