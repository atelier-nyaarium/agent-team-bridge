import { z } from "zod";

// Router wire schemas. Relay payloads stay opaque here and are validated by their consumers.

/** Chunk size shared by all runtimes and bounded by the phone's transient heap use. */
export const BLOB_CHUNK_BYTES = 1_048_576;

/** Attachment limit. Enforce it on received bytes, not sender-declared metadata. */
export const MAX_BLOB_BYTES = 500_000_000;

/**
 * Ceiling a single sealed relay frame may not cross, asserted in tests against the WebSocket
 * limits set explicitly on both ends of the gateway<->Router socket. An oversized frame does not
 * merely fail there: it closes the socket and takes every team's traffic with it.
 */
export const MAX_RELAY_FRAME_BYTES = 8_000_000;

/** Frames received from the Router. Unknown types are logged and dropped. */
export const RouterInboundFrameSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("tool_result"),
		callId: z.string(),
		result: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("tool_error"),
		// Null identifies malformed input that carried no call id.
		callId: z.string().nullable(),
		error: z.string().optional(),
	}),
	// The relay pump validates the full payload.
	z.looseObject({
		type: z.literal("console_relay"),
	}),
	// The gateway-relay pump validates the full payload.
	z.looseObject({
		type: z.literal("gateway_relay"),
	}),
	// The handshake pump validates this opaque payload.
	z.looseObject({
		type: z.literal("cross_domain_handshake"),
	}),
	// The handshake pump validates and pairs the reveal with round one.
	z.looseObject({
		type: z.literal("cross_domain_handshake_reveal"),
	}),
	// The Gateway validates the opaque snapshot with DomainSnapshotSchema.
	z.object({
		type: z.literal("domain_update"),
		domain: z.unknown(),
		version: z.string().optional(),
		displayName: z.string().nullish(),
	}),
	z.object({
		type: z.literal("inbox_deliver"),
		address: z.string(),
		rows: z.unknown(),
		incarnation: z.number().int().positive(),
		deliveryEpoch: z.number().int().positive(),
	}),
	z.object({
		type: z.literal("blob_fetch"),
		opId: z.string().min(1),
		blobId: z.string().min(1),
		range: z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive() }).optional(),
		incarnation: z.number().int().positive(),
	}),
	// Lost sequence requires a baseline.
	z.object({
		type: z.literal("presence_resync"),
		incarnation: z.number().int().positive(),
	}),
	// Link removal drops peer state.
	z.object({
		type: z.literal("unlink"),
		domainId: z.string().min(1),
		incarnation: z.number().int().positive(),
	}),
]);

/** The one frame the gateway SENDS (besides console_relay_reply, which travels
 * AS a tool_call and is intercepted by tool name on the Router side). */
export const ToolCallFrameSchema = z.object({
	type: z.literal("tool_call"),
	callId: z.string().min(1),
	action: z.string().min(1),
	params: z.record(z.string(), z.unknown()),
});

export const InboxAppendParamsSchema = z.object({
	address: z.string(),
	// Pump parses rows with InboxRowSchema.
	row: z.unknown(),
	opKey: z.unknown().optional(),
	incarnation: z.number().int().positive(),
});

export const InboxAckParamsSchema = z.object({
	address: z.string(),
	seq: z.number().int().min(1),
	incarnation: z.number().int().positive(),
	deliveryEpoch: z.number().int().positive(),
	outcome: z.enum(["delivered", "waking", "failed"]),
	reason: z.string().optional(),
});

export const SessionUpsertParamsSchema = z.object({
	sessionId: z.string(),
	kind: z.string(),
	label: z.string(),
	recordExists: z.boolean(),
	incarnation: z.number().int().positive(),
});

export const SessionForgetParamsSchema = z.object({
	sessionId: z.string(),
	incarnation: z.number().int().positive(),
});

export const BlobFetchParamsSchema = z.object({
	opId: z.string(),
	blobId: z.string(),
	range: z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive() }).optional(),
	origin: z.object({ domainId: z.string().min(1), gatewayId: z.string().min(1) }).optional(),
	incarnation: z.number().int().positive(),
});

/** The console's own blob read. No incarnation: a console has no gateway registration, and the
 * OwnerOp that carries this already proved which Domain is asking. */
export const OwnerBlobFetchParamsSchema = z.object({
	kind: z.literal("blob_fetch"),
	opId: z.string().min(1),
	blobId: z.string().min(1),
	range: z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive() }).optional(),
	origin: z.object({ domainId: z.string().min(1), gatewayId: z.string().min(1) }).optional(),
});

/** Uploads retain the origin copy. */
export const BlobBeginParamsSchema = z.object({
	blobId: z.string().min(1),
	size: z.number().int().nonnegative().max(MAX_BLOB_BYTES),
	store: z.enum(["cache", "held"]),
	/** Held blobs require references. */
	ref: z.object({ kind: z.enum(["entry", "row", "scheduled"]), id: z.string().min(1).max(256) }).optional(),
	incarnation: z.number().int().positive(),
});

export const BlobChunkParamsSchema = z.object({
	blobId: z.string().min(1),
	store: z.enum(["cache", "held"]),
	lease: z.object({ id: z.string().min(1), generation: z.number().int().positive() }),
	offset: z.number().int().nonnegative(),
	bytes: z.string().max(BLOB_CHUNK_BYTES * 2),
	final: z.boolean(),
	incarnation: z.number().int().positive(),
});

export const BlobFetchReplyParamsSchema = z.object({
	opId: z.string().min(1),
	outcome: z.enum(["fetched", "absent"]),
	bytes: z.string().optional(),
	eof: z.boolean().optional(),
	incarnation: z.number().int().positive(),
});

////////////////////////////////
//  Federation (multi-Gateway routing through the Router)
//
//  The Router is content-blind. A Gateway REGISTERS its gateway id on
//  connect, then reaches another Gateway by calling the Router's `gateway_relay` tool; it
//  routes the frame to the destination Gateway's socket by `dstGateway` alone and
//  correlates the eventual `gateway_relay_reply` by `relayId`. The `payload` is
//  opaque to the Router (a sealed blob only the destination Gateway can open), so these
//  schemas validate only the routing envelope.

/** Bumped when a federation wire shape changes. The Router rejects a Gateway registering
 * below its own floor with a typed close; the Gateway then degrades to single-Gateway. */
export const FEDERATION_PROTOCOL_VERSION = 1;

/** `gateway_register` tool-call params: a Gateway announces its id + wire version,
 * plus the optional admitted-identity proof (signPub/boxPub + an owner-signed
 * admission + a fresh possession proof). The auth fields stay opaque strings here;
 * the Router parses `admission` and checks it with verifyRegistration. Optional at this
 * parse layer (parse-then-verify): verifyRegistration is the gate that rejects an
 * unadmitted Gateway, with no bearer fallback. */
export const GatewayRegisterParamsSchema = z.object({
	gatewayId: z.string().min(1).max(64),
	// This Gateway's Domain id (multi-tenant Router). Optional + min(1) on the wire so a
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
	// Fresh per-registration random; the Router rejects a seen nonce within the freshness
	// window so a captured proof cannot be replayed even inside the skew.
	proofNonce: z.string().min(1).optional(),
});

/** `gateway_relay` tool-call params: the routing envelope the Router routes on. */
export const GatewayRelayRouteSchema = z.object({
	relayId: z.string().min(1).max(128),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	// The sender's Domain id. The Router stamps it from the SENDER connection's
	// registered Domain (content-blind) so the destination resolves the source by the
	// full (domainId, gatewayId) pair, since a gateway id is not unique across Domains.
	// Optional + min(1) on the wire, but the Router always stamps a real src Domain.
	srcDomain: z.string().min(1).max(64).optional(),
	// Opaque to the Router. The destination gateway parses/unseals it.
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

export type RouterInboundFrame = z.infer<typeof RouterInboundFrameSchema>;
export type ToolCallFrame = z.infer<typeof ToolCallFrameSchema>;
export type InboxAppendParams = z.infer<typeof InboxAppendParamsSchema>;
export type InboxAckParams = z.infer<typeof InboxAckParamsSchema>;
export type SessionUpsertParams = z.infer<typeof SessionUpsertParamsSchema>;
export type SessionForgetParams = z.infer<typeof SessionForgetParamsSchema>;
export type BlobFetchParams = z.infer<typeof BlobFetchParamsSchema>;
export type BlobFetchReplyParams = z.infer<typeof BlobFetchReplyParamsSchema>;
export type GatewayRegisterParams = z.infer<typeof GatewayRegisterParamsSchema>;
export type GatewayRelayRoute = z.infer<typeof GatewayRelayRouteSchema>;
export type GatewayRelayReplyParams = z.infer<typeof GatewayRelayReplyParamsSchema>;
export type CrossDomainHandshakeRoute = z.infer<typeof CrossDomainHandshakeRouteSchema>;
export type CrossDomainHandshakeReplyParams = z.infer<typeof CrossDomainHandshakeReplyParamsSchema>;
export type CrossDomainHandshakeRevealRoute = z.infer<typeof CrossDomainHandshakeRevealRouteSchema>;
export type CrossDomainHandshakeRevealReplyParams = z.infer<typeof CrossDomainHandshakeRevealReplyParamsSchema>;
