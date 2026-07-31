////////////////////////////////
//  dsCard marker parsing
//
//  The compose-time authority for what a design card declares about itself. The wire carries the
//  result (ChannelFile.cardTitle/cardGroup/cardWidth/cardHeight), so the console docks a card from
//  fields alone; its own parser survives only for tap-time opening. Regex semantics mirror the
//  Kotlin twin in android/.../plugins/designer/DesignerCards.kt exactly.

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

// The marker must LEAD the file (same contract as claude.ai/design's self-check): a first-line
// `<!-- @dsCard ... -->` comment, nothing but whitespace before it.
const MARKER = /^\s*<!--\s*@dsCard([^>]*?)-->/;
const ATTR = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
const TITLE = /<title>([^<]*)<\/title>/i;

/** Wire bounds from ChannelFileSchema. Title and group are display strings, so an overlong one is
 * clipped rather than failing the whole message; width/height are display hints, so an out-of-range
 * one is dropped rather than clipped to a lie. */
const MAX_TITLE = 200;
const MAX_GROUP = 64;
const MAX_DIMENSION = 8192;

/** Parse a design card's declared fields from its HTML, or null when the leading marker is absent
 * (the content is not a card). */
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
