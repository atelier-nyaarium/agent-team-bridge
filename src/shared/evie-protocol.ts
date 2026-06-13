// SYNC-HASH: e86f4486c96baceec7468972cace5766
// SYNCED MODULE - source of truth: switchboard/src/shared/evie-protocol.ts
// Copied verbatim into: evie-bot/app/features/bridge/evie-protocol.ts
// MUST re-copy on change: cp src/shared/evie-protocol.ts ../evie-bot/app/features/bridge/evie-protocol.ts
import { z } from "zod";

////////////////////////////////
//  Evie bridge wire protocol
//
//  Frames exchanged over the arbiter<->evie-bot WebSocket. SELF-CONTAINED on
//  purpose: this module imports nothing but zod, so the verbatim copy needs
//  no import surgery; sibling shared modules import FROM it, never into it.
//
//  The phone_relay member stays loose: the arbiter's relay pump runs the
//  full PhoneRelayFrameSchema parse (shared/schemas.ts) with its own error
//  path, so the envelope union only routes by type - one parse, one error
//  surface, no divergent double-validation.

////////////////////////////////
//  Schemas

/**
 * Discord attachment metadata propagated from evie-bot through the bridge.
 *
 * Presence of `base64` means the bot fetched the bytes and the host MCP
 * plugin should materialize the file; absence means metadata-only (the agent
 * reaches the file via `evie_fetch_message_files`). No regex on `base64`: the
 * field can hold up to ~670 MB on the wire (the locked 500 MB hard backstop,
 * base64-inflated), so validation is shape-only.
 *
 * Mirror: evie-bot's `ForwardDmFile` interface in
 * `app/features/bridge/BridgeServer.ts` until the synced copy replaces it.
 */
export const ChannelFileSchema = z
	.object({
		filename: z.string().min(1).max(255),
		mime: z.string(),
		size: z.number().int().nonnegative(),
		descriptiveKey: z.string(),
		base64: z.string().optional(),
	})
	.meta({ id: "ChannelFile" });

export const ChannelFilesSchema = z.array(ChannelFileSchema);

/** One tool in the registry push. Matches evie-bot's `BridgeToolSchema`
 * (exportToolSchemas); `title` is tolerated for older senders. */
export const BridgeToolSchema = z.object({
	name: z.string().min(1),
	title: z.string().optional(),
	description: z.string(),
	parameters: z.record(z.string(), z.unknown()),
});

/** Frames the arbiter RECEIVES from evie-bot. Unknown `type` values fail the
 * union; the consumer logs and drops them (observability, not crash). */
export const EvieInboundFrameSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("tool_registry"),
		tools: z.array(BridgeToolSchema),
	}),
	z.object({
		type: z.literal("tool_result"),
		callId: z.string(),
		result: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("tool_error"),
		// Nullable on purpose: evie's BridgeTransport sends callId: null for
		// invalid JSON and malformed envelopes that never carried an id.
		callId: z.string().nullable(),
		error: z.string().optional(),
	}),
	z.object({
		type: z.literal("dm_forward"),
		content: z.string(),
		userId: z.string(),
		channelId: z.string(),
		messageId: z.string(),
		files: ChannelFilesSchema.optional(),
	}),
	// Loose: the relay pump owns full validation (see module header).
	z.looseObject({
		type: z.literal("phone_relay"),
	}),
]);

/** The one frame the arbiter SENDS (besides phone_relay_reply, which travels
 * AS a tool_call and is intercepted by tool name on the evie side). */
export const ToolCallFrameSchema = z.object({
	type: z.literal("tool_call"),
	callId: z.string().min(1),
	action: z.string().min(1),
	params: z.record(z.string(), z.unknown()),
});

////////////////////////////////
//  Types

export type ChannelFile = z.infer<typeof ChannelFileSchema>;
export type BridgeTool = z.infer<typeof BridgeToolSchema>;
export type EvieInboundFrame = z.infer<typeof EvieInboundFrameSchema>;
export type DmForwardFrame = Extract<EvieInboundFrame, { type: "dm_forward" }>;
export type ToolCallFrame = z.infer<typeof ToolCallFrameSchema>;
