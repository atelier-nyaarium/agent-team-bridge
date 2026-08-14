import { linkDestinations } from "./markdown.js";
import { canonicalKey, type ParseErrorCode, REF_SCHEME, type Ref, tryParseRef } from "./refGrammar.js";

////////////////////////////////
//  Interfaces & Types

/** One ref found in a message body. */
export interface FoundRef {
	ref: Ref;
	/** The canonical key this ref is filed under in the manifest. */
	key: string;
	/** Exactly as written, so an error quotes what the agent typed. */
	raw: string;
}

/** A destination that meant to be a ref and was not a well-formed one. */
export interface RefProblem {
	raw: string;
	code: ParseErrorCode;
	message: string;
	offset: number;
}

export interface ScanResult {
	refs: FoundRef[];
	problems: RefProblem[];
}

////////////////////////////////
//  Functions & Helpers

/**
 * Every distinct ref a message links, plus every malformed one, deduped by canonical key.
 *
 * `markdown.ts` decides what is a link at all, so a fenced or inline-code example never reaches
 * here. There is no masking: the hand-rolled version re-derived CommonMark and guessed wrong.
 */
export function scanRefs(body: string): ScanResult {
	// Also keeps a ref-less message off the parser entirely.
	if (!body.toLowerCase().includes(REF_SCHEME)) return { refs: [], problems: [] };

	const refs = new Map<string, FoundRef>();
	const problems: RefProblem[] = [];

	for (const raw of linkDestinations(body)) {
		const result = tryParseRef(raw);
		if (result.kind === "not-a-ref") continue;
		if (result.kind === "error") {
			problems.push({ raw, code: result.code, message: result.message, offset: result.offset });
			continue;
		}

		const key = canonicalKey(result.ref);
		if (!refs.has(key)) refs.set(key, { ref: result.ref, key, raw });
	}

	return { refs: [...refs.values()], problems };
}
