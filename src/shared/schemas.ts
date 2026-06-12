import { z } from "zod";

////////////////////////////////
//  CLI Reply Schema
//
//  CLI-mode replies are one-shot: the request arrives, the agent does work, it
//  replies exactly once with a terminal status. status is required.

export const CliReplySchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		status: z.enum(["completed", "clarification", "deferred", "needs_human"]).describe(`The outcome of your work.`),
		replyAsString: z
			.string()
			.optional()
			.describe(`Your text response. Lead with the answer itself: no lead-in labels ("Short answer:", "TLDR:") and no restating the question - replies often render on a phone. Mutually exclusive with replyAsJson.`),
		replyAsJson: z
			.string()
			.optional()
			.describe(
				`A JSON object response. Use when the request specifies a Reply Schema. Pass a valid JSON string matching the schema. Mutually exclusive with replyAsString.`,
			),
		question: z
			.string()
			.optional()
			.describe(`The specific question you need answered. Required when status is clarification.`),
		reason: z.string().optional().describe(`Why you are deferred or need a human. Required for those statuses.`),
		estimated_minutes: z.number().optional().describe(`Estimated minutes until you can handle this. For deferred.`),
		what_to_decide: z
			.string()
			.optional()
			.describe(`The specific decision or approval a human must make. Required for needs_human.`),
	})
	.refine((data) => !(data.replyAsString && data.replyAsJson), {
		message: "Provide replyAsString or replyAsJson, not both.",
	});

export type CliReplyArgs = z.infer<typeof CliReplySchema>;

////////////////////////////////
//  Channel Reply Schema
//
//  Channel-mode conversations are streams: the conversation stays open for the
//  life of the process, and the agent can reply any number of times. There is
//  no status because there is no "end". Every reply is just another message in
//  the stream.

export const ChannelReplySchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		replyAsString: z
			.string()
			.optional()
			.describe(`Your text response. Lead with the answer itself: no lead-in labels ("Short answer:", "TLDR:") and no restating the question - replies often render on a phone. Mutually exclusive with replyAsJson.`),
		replyAsJson: z
			.string()
			.optional()
			.describe(
				`A JSON object response. Use when the request specifies a Reply Schema. Pass a valid JSON string matching the schema. Mutually exclusive with replyAsString.`,
			),
		attachments: z
			.array(z.string())
			.optional()
			.describe(
				`Optional absolute file paths to attach to this reply (e.g. screenshots, logs). Images render inline on the phone; other files appear as download chips.`,
			),
	})
	.refine((data) => !(data.replyAsString && data.replyAsJson), {
		message: "Provide replyAsString or replyAsJson, not both.",
	});

export type ChannelReplyArgs = z.infer<typeof ChannelReplySchema>;

////////////////////////////////
//  respond_to_human Parts Schema
//
//  Each part becomes one Discord message. Strings auto-wrap to { text } via
//  schema-level transform so downstream consumers only see the object form.
//  Empty parts (no text and no attachments) are rejected at the input edge.

const Base64Pattern = /^[A-Za-z0-9+/]+=*$/;

export const PostResponseAttachmentSchema = z.object({
	filename: z.string().min(1).max(255),
	base64: z.string().regex(Base64Pattern, "must be valid base64"),
});

export type PostResponseAttachment = z.infer<typeof PostResponseAttachmentSchema>;

export const PostResponsePartSchema = z
	.union([
		z.string().min(1),
		z.object({
			text: z.string().min(1).optional(),
			attachments: z.array(PostResponseAttachmentSchema).min(1).optional(),
		}),
	])
	.transform((p) => (typeof p === "string" ? { text: p } : p))
	.refine((p) => !!p.text || !!p.attachments, {
		message: "part must have text or at least one attachment",
	})
	.describe(
		`Plain string for text-only, or { text?, attachments?: [{filename, base64}] } for attachment-bearing messages.`,
	);

export type PostResponsePart = z.infer<typeof PostResponsePartSchema>;

export const PostResponsePartsSchema = z.array(PostResponsePartSchema).min(1);

////////////////////////////////
//  Channel File Schema (inbound from evie-bot bridge)
//
//  Validates the per-attachment record on the dm_forward / channel_push path.
//  No regex on `base64` because the field can hold up to ~670 MB on the wire
//  (the locked 500 MB hard backstop, base64-inflated). Shape-only validation
//  catches malformed envelopes without the per-byte scan cost.
//
//  Mirror: evie-bot's `ForwardDmFile` interface in
//  `app/features/bridge/BridgeServer.ts`. Keep the shapes in lockstep.

export const ChannelFileSchema = z.object({
	filename: z.string().min(1).max(255),
	mime: z.string(),
	size: z.number().int().nonnegative(),
	descriptiveKey: z.string(),
	base64: z.string().optional(),
});

export const ChannelFilesSchema = z.array(ChannelFileSchema);

////////////////////////////////
//  Phone Relay Frame Schema
//
//  Validates phone_relay frames at the arbiter trust boundary. The frame body
//  is phone-authored and evie relays it opaquely, so the arbiter must not
//  blind-cast it. Mirror: the PhoneOp / PhoneRelayFrame types in
//  `shared/phone-protocol.ts`. Keep the shapes in lockstep.

export const PhoneOpSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("register") }),
	z.object({ kind: z.literal("list_teams") }),
	z.object({
		kind: z.literal("send"),
		to: z.string().min(1).max(128),
		request_type: z.enum(["feature", "bugfix", "question"]).optional(),
		effort: z.enum(["simple", "standard", "complex", "auto"]).optional(),
		body: z.string().min(1),
		files: ChannelFilesSchema.optional(),
	}),
	z.object({
		kind: z.literal("respond"),
		session_id: z.string().min(1),
		status: z.string().optional(),
		response: z.string().optional(),
		replyAsJson: z.record(z.string(), z.unknown()).optional(),
		files: ChannelFilesSchema.optional(),
	}),
	z.object({
		kind: z.literal("poll"),
		cursor: z.number().int().nonnegative().optional(),
		epoch: z.number().int().nonnegative().optional(),
		holdMs: z.number().int().nonnegative().max(45_000).optional(),
	}),
]);

export const PhoneRelayFrameSchema = z.object({
	type: z.literal("phone_relay"),
	v: z.number().int().positive(),
	device: z.string().min(1).max(64),
	conversationId: z.string().min(1).max(128),
	opId: z.string().min(1).max(128),
	op: PhoneOpSchema,
});
