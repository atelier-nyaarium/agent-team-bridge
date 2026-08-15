////////////////////////////////
//  dsCard marker parsing
//
//  Compose-time authority. The wire carries the result; this parser survives only for tap-time
//  opening. Regex semantics mirror the Kotlin twin in DesignerCards.kt exactly.

////////////////////////////////
//  Interfaces & Types

export interface DsCardFields {
	cardTitle?: string;
	cardGroup?: string;
	cardWidth?: number;
	cardHeight?: number;
}

////////////////////////////////
//  Functions & Helpers

// The marker must LEAD the file: first-line, nothing but whitespace before it.
const MARKER = /^\s*<!--\s*@dsCard([^>]*?)-->/;
const ATTR = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
const TITLE = /<title>([^<]*)<\/title>/i;

/** Title/group are clipped rather than failing the message; width/height are dropped rather than
 * clipped to a lie. */
const MAX_TITLE = 200;
const MAX_GROUP = 64;
const MAX_DIMENSION = 8192;

/** Null when the leading marker is absent. */
export function parseDsCard(html: string): DsCardFields | null {
	const match = MARKER.exec(html);
	if (!match) return null;
	const fields: DsCardFields = {};
	for (const attr of match[1].matchAll(ATTR)) {
		const value = attr[2];
		if (attr[1] === "group" && value) fields.cardGroup = value.slice(0, MAX_GROUP);
		if (attr[1] === "width") fields.cardWidth = boundedDimension(value);
		if (attr[1] === "height") fields.cardHeight = boundedDimension(value);
	}
	const title = TITLE.exec(html)?.[1]?.trim();
	if (title) fields.cardTitle = title.slice(0, MAX_TITLE);
	return fields;
}

function boundedDimension(value: string): number | undefined {
	const n = Number.parseInt(value, 10);
	return Number.isInteger(n) && n > 0 && n <= MAX_DIMENSION ? n : undefined;
}
