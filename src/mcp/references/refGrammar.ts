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

////////////////////////////////
//  Functions & Helpers

export const REF_SCHEME = "ref://";

const RANGE_SEP = "..";
const BEFORE_SEP = "@before:";
const AFTER_SEP = "@after:";

/**
 * Percent-decode one already-split component.
 *
 * Split first, decode second. The reverse order conflates a literal `%3A` in a filename with a
 * scope separator, so `ref://we%3Aird.ts:Foo` and `ref://we:ird.ts:Foo` would collapse onto one key
 * while meaning different things. Decoding here, after the structure is fixed, keeps them distinct.
 */
function decodeComponent(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		// A lone `%` is a literal percent in practice, not a caller asking for a decode failure.
		return raw;
	}
}

/**
 * Re-encode a component for the canonical key. Every character that could be read as structure is
 * encoded, so the key round-trips to the same parse. Deliberately not pretty: this is a lookup key
 * the MCP writes and the phone recomputes, and the only property that matters is that the two agree.
 */
function encodeComponent(raw: string): string {
	return raw.replace(/%/g, "%25").replace(/:/g, "%3A").replace(/#/g, "%23");
}

/** As above, plus the characters that carry structure inside a fragment. */
function encodeMatcherText(raw: string): string {
	return encodeComponent(raw).replace(/@/g, "%40").replace(/\./g, "%2E");
}

/**
 * Parse a fragment's structure from its RAW text, before any decoding. A literal `..` or `@` in the
 * searched-for text arrives percent-encoded, so anything still visible here is structure.
 */
function parseMatcher(rawFragment: string): Matcher | null {
	if (rawFragment === "") return null;

	const before = rawFragment.indexOf(BEFORE_SEP);
	if (before !== -1) {
		return {
			kind: "before",
			text: decodeComponent(rawFragment.slice(0, before)),
			anchor: decodeComponent(rawFragment.slice(before + BEFORE_SEP.length)),
		};
	}

	const after = rawFragment.indexOf(AFTER_SEP);
	if (after !== -1) {
		return {
			kind: "after",
			text: decodeComponent(rawFragment.slice(0, after)),
			anchor: decodeComponent(rawFragment.slice(after + AFTER_SEP.length)),
		};
	}

	const range = rawFragment.indexOf(RANGE_SEP);
	if (range !== -1) {
		return {
			kind: "range",
			from: decodeComponent(rawFragment.slice(0, range)),
			to: decodeComponent(rawFragment.slice(range + RANGE_SEP.length)),
		};
	}

	return { kind: "text", text: decodeComponent(rawFragment) };
}

/**
 * Parse a `ref://` URI into its structured form, or null if it is not one.
 *
 * Deliberately not `new URL()`: under URL rules `ref://app.js:Foo` reads `app.js` as a host and
 * `:Foo` as a port, which is not what any of this means.
 */
export function parseRef(uri: string): Ref | null {
	const trimmed = uri.trim().replace(/^<|>$/g, "");
	if (!trimmed.toLowerCase().startsWith(REF_SCHEME)) return null;

	const body = trimmed.slice(REF_SCHEME.length);
	if (body === "") return null;

	const hash = body.indexOf("#");
	const rawScope = hash === -1 ? body : body.slice(0, hash);
	const rawFragment = hash === -1 ? "" : body.slice(hash + 1);

	// An empty component is a merge, not a segment, so the natural C++ spelling `A::B::method`
	// parses as three waypoints rather than five with two blanks in between.
	const parts = rawScope.split(":").filter((p) => p !== "");
	if (parts.length === 0) return null;

	const [rawPath, ...rawSegments] = parts;
	return {
		path: decodeComponent(rawPath),
		segments: rawSegments.map(decodeComponent),
		matcher: parseMatcher(rawFragment),
	};
}

/** The matcher half of a canonical key. */
function serializeMatcher(matcher: Matcher): string {
	switch (matcher.kind) {
		case "text":
			return `#${encodeMatcherText(matcher.text)}`;
		case "before":
			return `#${encodeMatcherText(matcher.text)}${BEFORE_SEP}${encodeMatcherText(matcher.anchor)}`;
		case "after":
			return `#${encodeMatcherText(matcher.text)}${AFTER_SEP}${encodeMatcherText(matcher.anchor)}`;
		case "range":
			return `#${encodeMatcherText(matcher.from)}${RANGE_SEP}${encodeMatcherText(matcher.to)}`;
	}
}

/**
 * The stable identity of a ref: what the MCP writes as a manifest key and what the phone recomputes
 * from a tapped link. Two refs meaning the same thing produce the same key (`::` merged, hex case
 * normalized, angle brackets dropped); two meaning different things never do.
 */
export function canonicalKey(ref: Ref): string {
	const scope = [ref.path, ...ref.segments].map(encodeComponent).join(":");
	return `${REF_SCHEME}${scope}${ref.matcher ? serializeMatcher(ref.matcher) : ""}`;
}

/** Parse and canonicalize in one step, or null if the input is not a ref. */
export function canonicalizeUri(uri: string): string | null {
	const ref = parseRef(uri);
	return ref ? canonicalKey(ref) : null;
}
