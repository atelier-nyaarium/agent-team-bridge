import { z } from "zod";

////////////////////////////////
//  Shared enum schemas
//
//  The single truth for the wire enums; the TS types in types.ts derive from
//  these via z.infer. Decode-side tolerance note: these closed enums validate
//  what OUR side composes or what a closed protocol surface accepts. Fields a
//  phone DECODES (e.g. MailboxEntry.request_type) stay open strings - see the
//  schema-first plan's additive rule.

export const ConnectionModeSchema = z.enum(["cli", "channel"]).meta({ id: "ConnectionMode" });
export const EffortLevelSchema = z.enum(["simple", "standard", "complex"]).meta({ id: "EffortLevel" });
export const RequestTypeSchema = z.enum(["feature", "bugfix", "question"]).meta({ id: "RequestType" });
export const TeamKindSchema = z.enum(["devcontainer", "loose", "phone"]).meta({ id: "TeamKind" });
export const ResponseStatusSchema = z
	.enum(["completed", "clarification", "deferred", "needs_human", "error", "timeout", "running"])
	.meta({ id: "ResponseStatus" });

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
			.describe(
				`Your text response. Lead with the answer itself: no lead-in labels ("Short answer:", "TLDR:") and no restating the question - replies often render on a phone. Mutually exclusive with replyAsJson.`,
			),
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
			.describe(
				`Your text response. Lead with the answer itself: no lead-in labels ("Short answer:", "TLDR:") and no restating the question - replies often render on a phone. Mutually exclusive with replyAsJson.`,
			),
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
//  Channel File Schema (inbound from evie-bot bridge)
//
//  Owned by evie-protocol.ts (the self-contained module synced into
//  evie-bot); re-exported here so the phone-protocol schemas and existing
//  importers keep one import surface.

import { ChannelFilesSchema } from "./evie-protocol.js";

export { ChannelFileSchema, ChannelFilesSchema } from "./evie-protocol.js";

////////////////////////////////
//  WS Register Schema
//
//  Validates the register message at the bridge WebSocket boundary - the one
//  message where a blind-cast team name could key the registry on undefined.
//  mode stays an open string (the handler maps anything non-"channel" to
//  "cli", tolerant of future modes).

export const WsRegisterSchema = z.object({
	type: z.literal("register"),
	team: z.string().min(1).max(64),
	mode: z.string().optional(),
	subId: z.string().optional(),
	conversationId: z.string().optional(),
});

////////////////////////////////
//  Team Info Schema
//
//  The per-team record in list_teams results and the /teams route. `status` is
//  the wire word verbatim; `kind` separates wakeable devcontainer projects from
//  ad-hoc loose sessions.

export const TeamInfoSchema = z
	.object({
		team: z.string(),
		status: z.enum(["online", "available"]),
		mode: ConnectionModeSchema.optional(),
		// Optional for decode tolerance: old arbiters omit kind and consumers
		// default it to "loose" (the hand Kotlin client always did).
		kind: TeamKindSchema.optional(),
		queue_depth: z.number().int().nonnegative(),
	})
	.meta({ id: "TeamInfo" });

////////////////////////////////
//  Phone Relay Frame Schema
//
//  Validates phone_relay frames at the arbiter trust boundary. The frame body
//  is phone-authored and evie relays it opaquely, so the arbiter must not
//  blind-cast it. The phone-protocol.ts types derive from these schemas via
//  z.infer - this file is the single truth for the phone wire.

export const PhoneOpSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("register") }),
		z.object({ kind: z.literal("list_teams") }),
		z.object({
			kind: z.literal("send"),
			to: z.string().min(1).max(128),
			request_type: RequestTypeSchema.optional(),
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
	])
	.meta({ id: "PhoneOp" });

export const PhoneRelayFrameSchema = z
	.object({
		type: z.literal("phone_relay"),
		v: z.number().int().positive(),
		device: z.string().min(1).max(64),
		conversationId: z.string().min(1).max(128),
		opId: z.string().min(1).max(128),
		op: PhoneOpSchema,
	})
	.meta({ id: "PhoneRelayFrame" });

////////////////////////////////
//  Mailbox Entry Schema (arbiter -> phone)
//
//  Composed by the arbiter, decoded by the phone. `kind` is closed here
//  because the arbiter owns composition; the GENERATED Kotlin keeps it an
//  open String (decode-side rule). `request_type` is open even here: the
//  arbiter itself composes out-of-union values (e.g. "handoff" on transfer
//  briefs), so a closed enum would reject real traffic.

export const MailboxEntrySchema = z
	.object({
		seq: z.number().int().nonnegative(),
		at: z.number().int().nonnegative(),
		kind: z.enum(["message", "reply", "notice"]),
		session_id: z.string(),
		from: z.string().optional(),
		// Notification-bar line for notices; the body carries the full report.
		title: z.string().optional(),
		// The Short tier of a notice (4-6 sentences), addressable on its own so
		// phone features never parse it back out of the body. Always sent by
		// current arbiters; optional for decode tolerance of older wires.
		summary: z.string().optional(),
		body: z.string().optional(),
		status: z.string().optional(),
		replyAsJson: z.record(z.string(), z.unknown()).optional(),
		question: z.string().optional(),
		reason: z.string().optional(),
		request_type: z.string().optional(),
		effort: z.string().optional(),
		is_follow_up: z.boolean().optional(),
		files: ChannelFilesSchema.optional(),
	})
	.meta({ id: "MailboxEntry" });

////////////////////////////////
//  Op result schemas (arbiter -> phone)
//
//  No wire discriminator: the reply is correlated to its op by opId and the
//  phone decodes the result it expects per op. These generate as independent
//  Kotlin data classes, never a sealed hierarchy.

export const PhoneRegisterResultSchema = z
	.object({
		device: z.string(),
		// Current mailbox high-water seq so a reconnecting phone can resync its cursor.
		cursor: z.number().int().nonnegative(),
		// Mailbox instance id. If it differs from the phone's stored epoch, the
		// mailbox was recreated and the phone must reset its cursor to 0.
		epoch: z.number().int().nonnegative(),
	})
	.meta({ id: "PhoneRegisterResult" });

export const PhoneListTeamsResultSchema = z
	.object({
		teams: z.array(TeamInfoSchema),
	})
	.meta({ id: "PhoneListTeamsResult" });

export const PhoneSendResultSchema = z
	.object({
		session_id: z.string(),
		status: z.string(),
	})
	.meta({ id: "PhoneSendResult" });

export const PhoneRespondResultSchema = z
	.object({
		delivered: z.boolean(),
	})
	.meta({ id: "PhoneRespondResult" });

export const PhonePollResultSchema = z
	.object({
		entries: z.array(MailboxEntrySchema),
		cursor: z.number().int().nonnegative(),
		// Cumulative count of entries evicted by the cap before the phone read
		// them. Never reset server-side; the phone detects a new gap by comparing
		// against the previous total (or by a non-contiguous seq jump).
		dropped: z.number().int().nonnegative(),
		// Mailbox instance id. On change the phone resets its cursor to 0 (the
		// prior mailbox was evicted and a new one started seq at 1).
		epoch: z.number().int().nonnegative(),
	})
	.meta({ id: "PhonePollResult" });

export const PhoneOpResultSchema = z.union([
	PhoneRegisterResultSchema,
	PhoneListTeamsResultSchema,
	PhoneSendResultSchema,
	PhoneRespondResultSchema,
	PhonePollResultSchema,
]);

export const PhoneRelayReplySchema = z
	.object({
		type: z.literal("phone_relay_reply"),
		v: z.number().int().positive(),
		opId: z.string().min(1).max(128),
		ok: z.boolean(),
		result: PhoneOpResultSchema.optional(),
		error: z.string().optional(),
	})
	.meta({ id: "PhoneRelayReply" });

////////////////////////////////
//  Provisioning Schema
//
//  The blob the user pastes at phone setup. Credentials + endpoints only;
//  user taste lives in prefs. Runtime defaulting stays app-side (device from
//  Build.MODEL, conversationId minting a UUID, trimEnd('/') URL normalization)
//  - the schema carries the shape, the Kotlin wrapper owns those behaviors.

export const ProvisioningSchema = z
	.object({
		apiUrl: z.string().min(1),
		caPem: z.string(),
		saToken: z.string(),
		appToken: z.string().optional(),
		namespace: z.string().optional(),
		service: z.string().optional(),
		port: z.number().int().positive().optional(),
		device: z.string().optional(),
		conversationId: z.string().optional(),
		// STTS (TTS playback) service base URL + API key; absent disables Play.
		sttsUrl: z.string().optional(),
		sttsKey: z.string().optional(),
	})
	.meta({ id: "Provisioning" });
