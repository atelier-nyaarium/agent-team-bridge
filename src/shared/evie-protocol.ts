// SYNC-HASH: 04105779c0a213007b344953f4a07598
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
 * Channel attachment metadata carried over the bridge (phone-origin files).
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
		type: z.literal("phone_relay"),
	}),
	// Loose: a cross-Host frame evie routed to this Host. The host-relay pump runs
	// the full federation parse (federation-protocol.ts); evie only switched it
	// here by destination Host, never reading the inner payload.
	z.looseObject({
		type: z.literal("host_relay"),
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
//  Federation (multi-Host routing through evie)
//
//  evie is the content-blind Router. A Host's arbiter REGISTERS its host id on
//  connect, then reaches another Host by calling evie's `host_relay` tool; evie
//  switches the frame to the destination Host's socket by `dstHost` alone and
//  correlates the eventual `host_relay_reply` by `relayId`. The `payload` is
//  opaque to evie (cleartext op in the plaintext spike; a sealed blob once the
//  crypto phase lands), so these schemas validate only the routing envelope.

/** Bumped when a federation wire shape changes. evie rejects a Host registering
 * below its own floor with a typed close; the Host then degrades to single-Host. */
export const FEDERATION_PROTOCOL_VERSION = 1;

/** `arbiter_register` tool-call params: a Host announces its id + wire version,
 * plus the optional admitted-identity proof (signPub/boxPub + an owner-signed
 * admission + a fresh possession proof). The auth fields stay opaque strings here
 * so this leaf keeps importing nothing but zod; evie parses `admission` with the
 * synced SignedAdmissionSchema and checks it with verifyRegistration. They are
 * optional for a pre-enrollment / token-only Host; evie gates only once it holds
 * a Domain trust anchor. */
export const ArbiterRegisterParamsSchema = z.object({
	hostId: z.string().min(1).max(64),
	protocolVersion: z.number().int().positive(),
	signPub: z.string().min(1).optional(),
	boxPub: z.string().min(1).optional(),
	// JSON-encoded SignedAdmission (owner-signed). Parsed downstream, not here.
	admission: z.string().min(1).optional(),
	// Ed25519 signature over registerSigningBytes(hostId, proofAt, proofNonce) (base64).
	proof: z.string().min(1).optional(),
	proofAt: z.number().int().nonnegative().optional(),
	// Fresh per-registration random; evie rejects a seen nonce within the freshness
	// window so a captured proof cannot be replayed even inside the skew.
	proofNonce: z.string().min(1).optional(),
});

/** `host_relay` tool-call params: the routing envelope evie switches on. */
export const HostRelayRouteSchema = z.object({
	relayId: z.string().min(1).max(128),
	srcHost: z.string().min(1).max(64),
	dstHost: z.string().min(1).max(64),
	// Opaque to evie. The destination arbiter parses/unseals it.
	payload: z.unknown(),
});

/** `host_relay_reply` tool-call params: the destination Host's answer, routed
 * back to the originating Host's held `host_relay` call by `relayId`. */
export const HostRelayReplyParamsSchema = z.object({
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
export type ArbiterRegisterParams = z.infer<typeof ArbiterRegisterParamsSchema>;
export type HostRelayRoute = z.infer<typeof HostRelayRouteSchema>;
export type HostRelayReplyParams = z.infer<typeof HostRelayReplyParamsSchema>;
