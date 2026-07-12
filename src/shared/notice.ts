// SYNC-HASH: 787f63034cd2836827e1278c18e5dca9
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
//  - fullSpoken: the spoken copy of full (faithful except deliberate abridgements)
//
//  The SINGLE TRUTH for the notify_human tool param and the /human/notify
//  wire. zod-only LEAF (no relative imports) so the verbatim copy needs no
//  surgery. Tier semantics live on the field describes (the parameter-describe
//  doctrine: rules about what goes IN a field belong on that field).

////////////////////////////////
//  Field schemas (reused by each tool's own object so the describes stay
//  in one place even where a consumer loosens a field's optionality).

export const NoticeTitle = z
	.string()
	.min(1)
	.max(200)
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
		`A spoken copy of full, read aloud in its place. Faithful to the full body word for word, except deliberate abridgements (a code block becomes a short spoken mention of what it is). Spoken language only: no code, symbols, or raw identifiers. Write words as you would say them (say "hypothesis 1", not hyp-01). No lazy-join run-on sentences. Give each clause its own short sentence. Lowercase excitement (write "Yay!", never "YAY!").`,
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
