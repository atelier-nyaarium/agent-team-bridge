import { linkDestinations } from "./markdown.js";
import { canonicalKey, type ParseErrorCode, REF_SCHEME, type Ref, tryParseRef } from "./refGrammar.js";

////////////////////////////////
//  Interfaces & Types

/** One ref found in a message body. */
export interface FoundRef {
	ref: Ref;
	/** The canonical key this ref is filed under in the manifest. */
	key: string;
	/** The destination exactly as written, so an error can quote what the agent typed. */
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
 * Every distinct ref a message links, plus every malformed one.
 *
 * Which destinations exist at all is decided by the console's own markdown parser (see
 * `markdown.ts`), so a fenced example, an inline-code example, and a bare mention in prose are all
 * simply not links and never reach this function. That is the whole reason there is no masking here:
 * the previous hand-rolled version had to re-derive CommonMark, and every place it guessed wrong
 * either dropped a real ref with no error or attached a snapshot for an example.
 *
 * Refs dedupe by canonical key, which is what makes several links to one symbol free.
 */
export function scanRefs(body: string): ScanResult {
	// Nothing can be a ref without the scheme appearing somewhere, and this keeps a message with no
	// refs from depending on the parser being loadable at all.
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
