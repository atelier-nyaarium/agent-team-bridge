import { canonicalKey, parseRef, type Ref } from "./refGrammar.js";

////////////////////////////////
//  Interfaces & Types

/** One ref found in a message body. */
export interface FoundRef {
	ref: Ref;
	/** The canonical key this ref will be filed under in the manifest. */
	key: string;
	/** The destination exactly as written, so an error can quote what the agent typed. */
	raw: string;
}

////////////////////////////////
//  Functions & Helpers

// A markdown inline-link destination: `](dest)` or `](<dest>)`, with an optional title after it.
// Only this form is scanned. A bare `ref://...` in prose is not a link and gets no snapshot, which
// keeps the trigger something the agent typed on purpose.
const LINK_DESTINATION = /\]\(\s*(?:<([^>\n]*)>|([^\s()]+))/g;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Mark every character inside a fenced code block or an inline code span.
 *
 * The masking direction matters and is not symmetric. Failing to mask attaches a snapshot for an
 * example ref written while documenting the feature, and (worse) can hard-fail the send when that
 * example names no real file. Over-masking silently drops a ref the agent meant, with no error
 * anywhere. So this covers the two forms an example is actually written in and does not guess at
 * indented code blocks, whose boundaries cannot be decided without full block parsing.
 */
function maskCode(body: string): boolean[] {
	const mask = new Array<boolean>(body.length).fill(false);

	// Fences first: a backtick run inside a fenced block is content, not an inline span.
	let offset = 0;
	let fence: string | null = null;
	for (const line of body.split("\n")) {
		const match = FENCE_LINE.exec(line);
		const marker = match?.[1];
		if (fence === null) {
			// An opening fence's info string may not contain a backtick, per CommonMark.
			if (marker && !(marker.startsWith("`") && match?.[2]?.includes("`"))) fence = marker;
		} else if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
			fence = null;
			mask.fill(true, offset, offset + line.length);
		}
		if (fence !== null) mask.fill(true, offset, offset + line.length);
		offset += line.length + 1;
	}

	// Inline spans, in whatever the fences left. A span is opened and closed by backtick runs of
	// EQUAL length, so a run of a different length inside one is ordinary content.
	let i = 0;
	while (i < body.length) {
		if (body[i] !== "`" || mask[i]) {
			i++;
			continue;
		}
		let open = i;
		while (body[open] === "`") open++;
		const runLength = open - i;

		let search = open;
		while (search < body.length) {
			if (body[search] !== "`" || mask[search]) {
				search++;
				continue;
			}
			let close = search;
			while (body[close] === "`") close++;
			if (close - search === runLength) {
				mask.fill(true, i, close);
				i = close;
				break;
			}
			search = close;
		}
		// No closing run of equal length: the backticks are literal, so nothing is masked.
		if (search >= body.length) i = open;
	}

	return mask;
}

/**
 * Every distinct ref linked in a message body, in the order first written.
 *
 * Deduplicated by canonical key, which is what makes multiple links to one symbol free: the builder
 * ships one snapshot per file regardless of how many refs point into it.
 */
export function scanRefs(body: string): FoundRef[] {
	const mask = maskCode(body);
	const found = new Map<string, FoundRef>();

	LINK_DESTINATION.lastIndex = 0;
	let match = LINK_DESTINATION.exec(body);
	while (match !== null) {
		const raw = match[1] ?? match[2] ?? "";
		if (!mask[match.index]) {
			const ref = parseRef(raw);
			if (ref) {
				const key = canonicalKey(ref);
				if (!found.has(key)) found.set(key, { ref, key, raw });
			}
		}
		match = LINK_DESTINATION.exec(body);
	}

	return [...found.values()];
}
