// SYNCED MODULE - source of truth: switchboard/src/shared/notice.ts
// Copied verbatim into: nyaaskills/src/shared/notice.ts
// MUST re-copy on change: cp src/shared/notice.ts ../nyaaskills/src/shared/notice.ts
import { z } from "zod";

////////////////////////////////
//  Human notification contract
//
//  The three-tier notice a milestone report carries to the phone:
//  - title:   the notification-bar headline (one short phrase)
//  - summary: a short standalone tier phone features read directly
//  - full:    the message body (full markdown report)
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
	.describe(`1 short sentence or phrase - the notification-bar headline. Not a long-winded sentence.`);

export const NoticeSummary = z
	.string()
	.min(1)
	.describe(`4-6 plain sentences: what happened and what is next. Plain content, no lead-in labels ("Summary:").`);

export const NoticeFull = z
	.string()
	.min(1)
	.describe(`Full markdown report (mermaid renders too). Shown as the message body on the phone; no lead-in labels.`);

/** Deprecated alias for `title`. Accepted for one transition release so an
 * older caller (or a relay instruction minted before the rename) still
 * lands; resolve `title ?? tiny` and drop this once all callers send title. */
export const NoticeLegacyTiny = z
	.string()
	.min(1)
	.max(200)
	.optional()
	.describe(`Deprecated alias for \`title\`; use \`title\` instead.`);

////////////////////////////////
//  Schema + type

export const NoticeSchema = z.object({
	title: NoticeTitle,
	summary: NoticeSummary,
	full: NoticeFull,
});

export type Notice = z.infer<typeof NoticeSchema>;
