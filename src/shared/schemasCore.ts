import { z } from "zod";
import { NoticeFull, NoticeFullSpoken, NoticeSummary, NoticeTitle } from "./notice.js";

////////////////////////////////
//  Shared enum schemas
//
//  The single truth for the wire enums; types.ts derives from these via z.infer.
//  These closed enums validate what our side composes. Fields a console decodes
//  stay open strings.

export const ConnectionModeSchema = z.enum(["channel"]).meta({ id: "ConnectionMode" });
export const TeamKindSchema = z.enum(["devcontainer", "loose", "console"]).meta({ id: "TeamKind" });
export const ResponseStatusSchema = z
	.enum(["completed", "clarification", "deferred", "needs_human", "error", "timeout", "running"])
	.meta({ id: "ResponseStatus" });
// Whether a console's Domain is rooted yet. `unrooted` is a fresh, never-provisioned admin
// Domain; `pending` is an admin-staged tenant not yet first-rooted; `rooted` provisions the
// console. The gateway register reply only carries `rooted`/`unrooted` (a pending Domain has no
// gateway to register against); `pending` reaches the app via the blob's `pendingTenant`.
export const DomainStatusSchema = z.enum(["unrooted", "pending", "rooted"]).meta({ id: "DomainStatus" });

////////////////////////////////
//  Channel Reply Schemas
//
//  Channel-mode conversations are streams: the conversation stays open for the
//  life of the process and the agent can reply any number of times. There is no
//  status because there is no end. Two closed-shape tools, not one polymorphic
//  body: channel_reply is the ~99% prose path; channel_reply_structured is only
//  for a request that carries a reply_schema (e.g. the bridge handshake).

/** Appended to every prose-field describe whose content the console renders (channel_reply,
 * notify_human) - the cheap always-visible half of the escaped-newline guard; the pre-send lint
 * (`literalEscapeHazard` in mcp/bridge/replyTool.ts) is the enforcing half. The `\\n` spelling is
 * deliberate: the description must show the two-character sequence. */
export const REAL_NEWLINES_GUIDANCE = ` Use REAL newlines for line breaks, not \\n. Wrap intentional escapes in backticks or code spans.`;

/** The four notice tiers as the reply tools expose them: the leaf's canonical texts VERBATIM
 * with the newline guidance appended. Both tools (channel_reply here, notify_human in
 * mcp/channel/humanTools.ts) spread this SAME object, so their tier describes are identical
 * by construction, not by audit. */
export const GuidedNoticeTiers = {
	title: NoticeTitle.describe(`${NoticeTitle.description}${REAL_NEWLINES_GUIDANCE}`),
	summary: NoticeSummary.describe(`${NoticeSummary.description}${REAL_NEWLINES_GUIDANCE}`),
	full: NoticeFull.describe(`${NoticeFull.description}${REAL_NEWLINES_GUIDANCE}`),
	fullSpoken: NoticeFullSpoken.describe(`${NoticeFullSpoken.description}${REAL_NEWLINES_GUIDANCE}`),
};

export const ChannelReplySchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		...GuidedNoticeTiers,
		attachments: z
			.array(z.string())
			.optional()
			.describe(
				`Optional absolute file paths to attach to this reply (e.g. screenshots, logs). Images render inline on the console; other files appear as download chips. A self-contained .html file whose FIRST line is a "<!-- @dsCard group=... -->" comment is a design canvas: the console's Designer dock (a toggleable plugin) collects such cards per conversation for full-screen review. Card identity is the filename (re-attach the same filename to update a canvas in place), so name cards distinctly, e.g. "editor-form.html".`,
			),
	})
	.strict();

export type ChannelReplyArgs = z.infer<typeof ChannelReplySchema>;

export const ChannelReplyStructuredSchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		responseData: z
			.record(z.string(), z.unknown())
			.describe(
				`Reply to a request that carried a reply_schema (e.g. the bridge handshake). A native object matching that schema.`,
			),
	})
	.strict();

export type ChannelReplyStructuredArgs = z.infer<typeof ChannelReplyStructuredSchema>;
