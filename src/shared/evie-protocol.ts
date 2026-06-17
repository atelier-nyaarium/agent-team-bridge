// SYNC-HASH: 3be1990ab4fe3f36ac9ecf34d1d011a0
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
//  The console_relay member stays loose: the arbiter's relay pump runs the
//  full ConsoleRelayFrameSchema parse (shared/schemas.ts) with its own error
//  path, so the envelope union only routes by type - one parse, one error
//  surface, no divergent double-validation.

////////////////////////////////
//  Schemas

/**
 * Channel attachment metadata carried over the bridge (console-origin files).
 *
 * Presence of `base64` means the sender included the bytes and the host MCP
 * plugin should materialize the file; absence means metadata-only (no re-fetch
 * path - the bytes were not transferred). No regex on `base64`: the field can
 * hold up to ~670 MB on the wire (the locked 500 MB hard backstop,
 * base64-inflated), so validation is shape-only.
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
	// Loose: the relay pump owns full validation (see module header).
	z.looseObject({
		type: z.literal("console_relay"),
	}),
	// Loose: a cross-Switch frame evie routed to this Switch. The switch-relay pump runs
	// the full federation parse (federation-protocol.ts); evie only switched it
	// here by destination Switch, never reading the inner payload.
	z.looseObject({
		type: z.literal("switch_relay"),
	}),
]);

/** The one frame the arbiter SENDS (besides console_relay_reply, which travels
 * AS a tool_call and is intercepted by tool name on the evie side). */
export const ToolCallFrameSchema = z.object({
	type: z.literal("tool_call"),
	callId: z.string().min(1),
	action: z.string().min(1),
	params: z.record(z.string(), z.unknown()),
});

////////////////////////////////
//  Federation (multi-Switch routing through evie)
//
//  evie is the content-blind Router. A Switch REGISTERS its switch id on
//  connect, then reaches another Switch by calling evie's `switch_relay` tool; evie
//  switches the frame to the destination Switch's socket by `dstSwitch` alone and
//  correlates the eventual `switch_relay_reply` by `relayId`. The `payload` is
//  opaque to evie (a sealed blob only the destination Switch can open), so these
//  schemas validate only the routing envelope.

/** Bumped when a federation wire shape changes. evie rejects a Switch registering
 * below its own floor with a typed close; the Switch then degrades to single-Switch. */
export const FEDERATION_PROTOCOL_VERSION = 1;

/** `switch_register` tool-call params: a Switch announces its id + wire version,
 * plus the optional admitted-identity proof (signPub/boxPub + an owner-signed
 * admission + a fresh possession proof). The auth fields stay opaque strings here
 * so this leaf keeps importing nothing but zod; evie parses `admission` with the
 * synced SignedAdmissionSchema and checks it with verifyRegistration. They are
 * optional for a pre-enrollment / token-only Switch; evie gates only once it holds
 * a Domain trust anchor. */
export const SwitchRegisterParamsSchema = z.object({
	switchId: z.string().min(1).max(64),
	protocolVersion: z.number().int().positive(),
	signPub: z.string().min(1).optional(),
	boxPub: z.string().min(1).optional(),
	// JSON-encoded SignedAdmission (owner-signed). Parsed downstream, not here.
	admission: z.string().min(1).optional(),
	// Ed25519 signature over registerSigningBytes(switchId, proofAt, proofNonce) (base64).
	proof: z.string().min(1).optional(),
	proofAt: z.number().int().nonnegative().optional(),
	// Fresh per-registration random; evie rejects a seen nonce within the freshness
	// window so a captured proof cannot be replayed even inside the skew.
	proofNonce: z.string().min(1).optional(),
});

/** `switch_relay` tool-call params: the routing envelope evie switches on. */
export const SwitchRelayRouteSchema = z.object({
	relayId: z.string().min(1).max(128),
	srcSwitch: z.string().min(1).max(64),
	dstSwitch: z.string().min(1).max(64),
	// Opaque to evie. The destination arbiter parses/unseals it.
	payload: z.unknown(),
});

/** `switch_relay_reply` tool-call params: the destination Switch's answer, routed
 * back to the originating Switch's held `switch_relay` call by `relayId`. */
export const SwitchRelayReplyParamsSchema = z.object({
	relayId: z.string().min(1).max(128),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

////////////////////////////////
//  Types

export type ChannelFile = z.infer<typeof ChannelFileSchema>;
export type BridgeTool = z.infer<typeof BridgeToolSchema>;
export type EvieInboundFrame = z.infer<typeof EvieInboundFrameSchema>;
export type ToolCallFrame = z.infer<typeof ToolCallFrameSchema>;
export type SwitchRegisterParams = z.infer<typeof SwitchRegisterParamsSchema>;
export type SwitchRelayRoute = z.infer<typeof SwitchRelayRouteSchema>;
export type SwitchRelayReplyParams = z.infer<typeof SwitchRelayReplyParamsSchema>;
