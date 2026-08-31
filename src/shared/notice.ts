// SYNC-HASH: 0a9eb987710eccd8d1b3e4d5d458fba6
// SYNCED MODULE - source of truth: switchboard/src/shared/notice.ts
// Copied verbatim into: nyaaskills/src/shared/notice.ts
// MUST re-copy on change: cp src/shared/notice.ts ../nyaaskills/src/shared/notice.ts
import { z } from "zod";

////////////////////////////////
//  Human notification contract
//
//  The tiers a message carries to the console:
//  - title:      the notification-bar headline (one short phrase, read aloud)
//  - summary:    a short standalone tier console features read directly (read aloud)
//  - full:       the message body (full markdown report, rendered, never spoken)
//  - fullSpoken: full transcribed into spoken form (verbatim; only what a voice cannot read changes)
//
//  The SINGLE TRUTH for the notify_human tool param and the /human/notify
//  wire. zod-only LEAF (no relative imports) so the verbatim copy needs no
//  surgery. Tier semantics live on the field describes (the parameter-describe
//  doctrine: rules about what goes IN a field belong on that field).

////////////////////////////////
//  Field schemas (reused by each tool's own object so the describes stay
//  in one place even where a consumer loosens a field's optionality).

/** The headline bound, exported so a relay hop truncates to the same number this rejects past. */
export const NOTICE_TITLE_MAX = 200;

export const NoticeTitle = z
	.string()
	.min(1)
	.max(NOTICE_TITLE_MAX)
	.describe(
		`A very short one-line headline. It becomes the console's notification-bar line and is read aloud as the shortest text-to-speech tier. Spoken language only: no code, raw identifiers, or all-caps shouting.`,
	);

export const NoticeSummary = z
	.string()
	.min(1)
	.describe(
		`3-4 sentences summarizing this message, read aloud as the medium text-to-speech tier. Spoken language only: no code, symbols, or raw identifiers. Write words as you would say them (say "hypothesis 1", not hyp-01). No lazy-join run-on sentences. Give each clause its own short sentence. No all-caps shouting. No lead-in labels ("Summary:").`,
	);

export const NoticeFull = z
	.string()
	.min(1)
	.describe(
		`The full markdown body of this message. Markdown and mermaid render on the console. Lead with the answer or outcome. No lead-in labels ("Short answer:", "TLDR:", "Summary:").`,
	);

export const NoticeFullSpoken = z
	.string()
	.min(1)
	.describe(
		`
Verbatim spoken form of full. Same words, order, and sentences. Change only what TTS cannot read aloud. No rephrasing, reordering, splitting, merging, or summarizing.

The only allowed changes:
- Unspeakable tokens (code, symbols, raw identifiers, markdown markup, URLs) become spoken forms (say "Hypothesis 1", not HYP-01).
- A code block or long snippet becomes a short spoken mention.
- All-caps excitement uses normal casing (say "Yay!", not "YAY!").
`.trim(),
	);

////////////////////////////////
//  Schema + type

export const NoticeSchema = z.object({
	title: NoticeTitle,
	summary: NoticeSummary,
	full: NoticeFull,
	fullSpoken: NoticeFullSpoken,
});

export type Notice = z.infer<typeof NoticeSchema>;

////////////////////////////////
//  Wire projection
//
//  The tool boundary above is strict and required; every hop BELOW it (reply wire,
//  mailbox entry, federation relay, peer mirror) carries the spoken tiers as the
//  SAME lenient optional trio. Declaring the trio once and spreading it means a hop
//  cannot silently strip one tier while its siblings survive (non-strict zod drops
//  undeclared keys), and composing through one projection means a compose site
//  cannot drop a tier by omission. A consumer may override a spread field to
//  tighten it (e.g. a length cap), never to rename it. The body tier is deliberately
//  NOT part of the trio: it renames per surface (full -> response -> body), so each
//  surface owns its own body field.

export const NoticeTierWireFields = {
	title: z.string().optional(),
	summary: z.string().optional(),
	fullSpoken: z.string().optional(),
};

const NoticeTierWireSchema = z.object(NoticeTierWireFields);
export type NoticeTierWire = z.infer<typeof NoticeTierWireSchema>;

/** The spoken-tier field names, for the tools' prose-lint loops (each appends its own
 * surface's body field name). */
export const SPOKEN_TIER_FIELDS = Object.keys(NoticeTierWireFields) as (keyof NoticeTierWire)[];

/** Project the spoken tiers out of a tier-bearing payload, emitting only non-empty values:
 * a blank tier (producible only by a raw HTTP caller - the tool schemas enforce min length)
 * normalizes to absent at the first hop instead of riding the wire as "". */
export function pickTiers(src: NoticeTierWire): NoticeTierWire {
	const out: NoticeTierWire = {};
	for (const f of SPOKEN_TIER_FIELDS) if (src[f]) out[f] = src[f];
	return out;
}
