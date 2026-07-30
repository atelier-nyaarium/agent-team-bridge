// SYNC-HASH: 58dd0c9a31d25eff8a6d1b073de6982e
// SYNCED MODULE - source of truth: switchboard/src/shared/evie-protocol.ts
// Copied verbatim into: evie-bot/app/features/bridge/evie-protocol.ts
// MUST re-copy on change: cp src/shared/evie-protocol.ts ../evie-bot/app/features/bridge/evie-protocol.ts
import { z } from "zod";

////////////////////////////////
//  Evie bridge wire protocol
//
//  Frames exchanged over the gateway<->evie-bot WebSocket. Imports nothing but
//  zod so the verbatim copy needs no import surgery; sibling shared modules
//  import FROM it, never into it.
//
//  The console_relay member stays loose so the gateway's relay pump owns the
//  full ConsoleRelayFrameSchema parse (shared/schemas.ts): the union routes by
//  type only, avoiding divergent double-validation.

////////////////////////////////
//  Schemas

/**
 * Channel attachment metadata carried over the bridge (console-origin files).
 *
 * Presence of `base64` means the bytes are included and the host MCP plugin
 * should materialize the file; absence means metadata-only (no re-fetch path).
 * No regex on `base64`: it can hold ~670 MB (the 500 MB backstop, base64-inflated),
 * so validation is shape-only.
 */
export const ChannelFileSchema = z
	.object({
		filename: z.string().min(1).max(255),
		mime: z.string(),
		size: z.number().int().nonnegative(),
		descriptiveKey: z.string(),
		base64: z.string().optional(),
		// The source file's own mtime in epoch MILLISECONDS, so a save on the far side can restore
		// the real age rather than stamping now. Optional: a sender that cannot determine one omits
		// it and the receiver hides the row. Populate from `mtime.getTime()`, never `mtimeMs`, which
		// is fractional and fails this integer check. Bounded to the ECMAScript Date range, since a
		// larger safe integer is representable here but not by the Date every consumer builds.
		modifiedAt: z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000).optional(),
	})
	.meta({ id: "ChannelFile" });

export const ChannelFilesSchema = z.array(ChannelFileSchema);

/** Frames the gateway RECEIVES from evie-bot. Unknown `type` values fail the
 * union; the consumer logs and drops them (observability, not crash). */
export const EvieInboundFrameSchema = z.discriminatedUnion("type", [
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
	// Loose: a cross-Gateway frame. The gateway-relay pump runs the full federation
	// parse (federation-protocol.ts); evie routed by destination Gateway, never reading payload.
	z.looseObject({
		type: z.literal("gateway_relay"),
	}),
	// Loose: a pre-trust cross-Domain handshake frame (round 1, the requester's
	// commitment). The handshake pump validates; the Router never reads the payload.
	z.looseObject({
		type: z.literal("cross_domain_handshake"),
	}),
	// Loose: the round-2 reveal frame, routed the same way (the requester's revealed keys +
	// salt). The handshake pump validates and matches it to the round-1 pairing.
	z.looseObject({
		type: z.literal("cross_domain_handshake_reveal"),
	}),
	// The mirrored Domain pushed live when the owner admits or revokes a member, so a
	// revocation bites a connected Gateway within seconds rather than at its next register.
	// `domain` stays opaque here; the Gateway validates it with DomainSnapshotSchema.
	// `version` is the keyring hash the Gateway can echo to skip a redundant apply.
	// `displayName` carries the current display name because the allowlist the snapshot
	// feeds drops it, so a rename would otherwise not reach teams()/discover until a
	// reconnect. This frame only reaches the renamed Domain's own gateways.
	z.object({
		type: z.literal("domain_update"),
		domain: z.unknown(),
		version: z.string().optional(),
		displayName: z.string().nullish(),
	}),
]);

/** The one frame the gateway SENDS (besides console_relay_reply, which travels
 * AS a tool_call and is intercepted by tool name on the evie side). */
export const ToolCallFrameSchema = z.object({
	type: z.literal("tool_call"),
	callId: z.string().min(1),
	action: z.string().min(1),
	params: z.record(z.string(), z.unknown()),
});

////////////////////////////////
//  Federation (multi-Gateway routing through evie)
//
//  evie is the content-blind Router. A Gateway REGISTERS its gateway id on
//  connect, then reaches another Gateway by calling evie's `gateway_relay` tool; evie
//  routes the frame to the destination Gateway's socket by `dstGateway` alone and
//  correlates the eventual `gateway_relay_reply` by `relayId`. The `payload` is
//  opaque to evie (a sealed blob only the destination Gateway can open), so these
//  schemas validate only the routing envelope.

/** Bumped when a federation wire shape changes. evie rejects a Gateway registering
 * below its own floor with a typed close; the Gateway then degrades to single-Gateway. */
export const FEDERATION_PROTOCOL_VERSION = 1;

/** `gateway_register` tool-call params: a Gateway announces its id + wire version,
 * plus the optional admitted-identity proof (signPub/boxPub + an owner-signed
 * admission + a fresh possession proof). The auth fields stay opaque strings here;
 * evie parses `admission` and checks it with verifyRegistration. Optional at this
 * parse layer (parse-then-verify): verifyRegistration is the gate that rejects an
 * unadmitted Gateway, with no bearer fallback. */
export const GatewayRegisterParamsSchema = z.object({
	gatewayId: z.string().min(1).max(64),
	// This Gateway's Domain id (multi-tenant evie). Optional + min(1) on the wire so a
	// legacy/malformed frame still parses, but the Router's sanitizeDomainId rejects an
	// absent or empty id at register time - there is no implicit default Domain.
	domainId: z.string().min(1).max(64).optional(),
	protocolVersion: z.number().int().positive(),
	signPub: z.string().min(1).optional(),
	boxPub: z.string().min(1).optional(),
	// JSON-encoded SignedAdmission (owner-signed). Parsed downstream, not here.
	admission: z.string().min(1).optional(),
	// Ed25519 signature over registerSigningBytes(gatewayId, proofAt, proofNonce) (base64).
	proof: z.string().min(1).optional(),
	proofAt: z.number().int().nonnegative().optional(),
	// Fresh per-registration random; evie rejects a seen nonce within the freshness
	// window so a captured proof cannot be replayed even inside the skew.
	proofNonce: z.string().min(1).optional(),
});

/** `gateway_relay` tool-call params: the routing envelope evie routes on. */
export const GatewayRelayRouteSchema = z.object({
	relayId: z.string().min(1).max(128),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	// The sender's Domain id. The Router stamps it from the SENDER connection's
	// registered Domain (content-blind) so the destination resolves the source by the
	// full (domainId, gatewayId) pair, since a gateway id is not unique across Domains.
	// Optional + min(1) on the wire, but the Router always stamps a real src Domain.
	srcDomain: z.string().min(1).max(64).optional(),
	// Opaque to evie. The destination gateway parses/unseals it.
	payload: z.unknown(),
});

/** `gateway_relay_reply` tool-call params: the destination Gateway's answer, routed
 * back to the originating Gateway's held `gateway_relay` call by `relayId`. */
export const GatewayRelayReplyParamsSchema = z.object({
	relayId: z.string().min(1).max(128),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

////////////////////////////////
//  Cross-Domain handshake rendezvous (pre-trust, content-blind, commit-reveal)
//
//  Pairing two Gateways owned by DIFFERENT owners runs BEFORE either side trusts the
//  other, so it cannot ride the allowlist-gated gateway_relay (which routes within ONE
//  Domain). It is a commit-reveal exchange over two round trips so the Router cannot
//  offline-grind the SAS: each side commits to its keys, then reveals them. Both rounds
//  route the same way - the requester calls a tool, the Router forwards to `dstGateway`
//  and holds the call open until the receiver answers (correlated by `handshakeId`),
//  never reading `payload`.
//
//  Round 1 is `cross_domain_handshake` (commitment) -> `cross_domain_handshake_reply`.
//  Round 2 is `cross_domain_handshake_reveal` (keys + salt) ->
//  `cross_domain_handshake_reveal_reply` (the receiver's keys + salt + the SAS).
//
//  As the ONLY pre-trust cross-Domain ops they are NOT allowlist-gated, so the Router
//  rate-limits the round-1 call with a hard attempt cap, and the receiver accepts the
//  inner frames only while its single-use listening window is open.

/** `cross_domain_handshake` tool-call params: the routing envelope the Router routes on.
 * The requester knows the receiver's Gateway id (the listening-token prefix) but not its
 * Domain pre-trust, so the Router locates `dstGateway` across Domains (the pre-trust
 * exception). `srcDomain`/`srcGateway` are the requester's own ids. */
export const CrossDomainHandshakeRouteSchema = z.object({
	// Correlates the held reply (mirrors gateway_relay's relayId).
	handshakeId: z.string().min(1).max(128),
	srcDomain: z.string().min(1).max(64),
	srcGateway: z.string().min(1).max(64),
	// The receiver Gateway id (from the listening-token prefix); the Router resolves it
	// across Domains since the requester does not know the receiver's Domain yet.
	dstGateway: z.string().min(1).max(64),
	// Opaque to the Router: the requester's commitment frame (round 1). The SAS over the
	// committed keys is the MITM defense, so this carries no keys and is not sealed to a
	// not-yet-known peer.
	payload: z.unknown(),
});

/** `cross_domain_handshake_reply` tool-call params: the receiver Gateway's answer to
 * round 1 (its own commitment), routed back to the originating Gateway's held
 * `cross_domain_handshake` call by `handshakeId`. */
export const CrossDomainHandshakeReplyParamsSchema = z.object({
	handshakeId: z.string().min(1).max(128),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

/** `cross_domain_handshake_reveal` tool-call params: round 2's routing envelope (the
 * requester's revealed keys + salt). Identical routing shape to round 1; the Router
 * forwards `payload` verbatim to `dstGateway` and holds for the reveal reply. A distinct
 * `handshakeId` correlates this round's held call. */
export const CrossDomainHandshakeRevealRouteSchema = z.object({
	handshakeId: z.string().min(1).max(128),
	srcDomain: z.string().min(1).max(64),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	// Opaque to the Router: the requester's reveal frame (keys + ids + salt). The receiver
	// checks it against the round-1 commitment before computing the SAS.
	payload: z.unknown(),
});

/** `cross_domain_handshake_reveal_reply` tool-call params: the receiver Gateway's round-2
 * answer (its revealed keys + salt + the SAS), routed back to the origin by `handshakeId`. */
export const CrossDomainHandshakeRevealReplyParamsSchema = z.object({
	handshakeId: z.string().min(1).max(128),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

////////////////////////////////
//  Types

export type ChannelFile = z.infer<typeof ChannelFileSchema>;
export type EvieInboundFrame = z.infer<typeof EvieInboundFrameSchema>;
export type ToolCallFrame = z.infer<typeof ToolCallFrameSchema>;
export type GatewayRegisterParams = z.infer<typeof GatewayRegisterParamsSchema>;
export type GatewayRelayRoute = z.infer<typeof GatewayRelayRouteSchema>;
export type GatewayRelayReplyParams = z.infer<typeof GatewayRelayReplyParamsSchema>;
export type CrossDomainHandshakeRoute = z.infer<typeof CrossDomainHandshakeRouteSchema>;
export type CrossDomainHandshakeReplyParams = z.infer<typeof CrossDomainHandshakeReplyParamsSchema>;
export type CrossDomainHandshakeRevealRoute = z.infer<typeof CrossDomainHandshakeRevealRouteSchema>;
export type CrossDomainHandshakeRevealReplyParams = z.infer<typeof CrossDomainHandshakeRevealReplyParamsSchema>;
