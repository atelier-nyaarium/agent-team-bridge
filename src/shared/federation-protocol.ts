import { z } from "zod";
import { ChannelFilesSchema } from "./evie-protocol.js";

////////////////////////////////
//  Federation inner protocol (gateway <-> gateway, via evie)
//
//  evie routes the OUTER envelope (evie-protocol.ts: relayId / srcGateway / dstGateway)
//  and never reads the payload. THIS module is the inner vocabulary the two
//  gateways share and evie does not: the federated op a Gateway runs on a peer's
//  behalf, the return-route that pins a reply back to the origin session, and the
//  crypto-aware payload wrapper. It is NOT codegen'd to Kotlin - cross-Gateway
//  traffic is gateway-to-gateway; the console reaches the mesh through its home
//  Gateway. Re-export `FEDERATION_PROTOCOL_VERSION` from the synced leaf so both the
//  wire version and the inner ops travel from one import surface.

export { FEDERATION_PROTOCOL_VERSION } from "./evie-protocol.js";

////////////////////////////////
//  Schemas

/** How a destination Gateway pins a reply back to the originating Gateway's exact
 * session. Carried on a cross-Gateway `send`, stored on the destination job, and
 * read by `respond` to forward the response_push back across evie. `srcSession`
 * is the origin's channel job key (`conv:<srcConversationId>:<dstGateway>/<name>`),
 * used as the job key on BOTH Gatewayes so neither side has to translate. */
export const ReturnRouteSchema = z.object({
	srcGateway: z.string().min(1).max(64),
	srcConversationId: z.string().min(1).max(128),
	srcSession: z.string().min(1).max(256),
});

/** The op a Gateway executes on a peer's behalf. Always carried E2E-sealed inside the
 * gateway_relay payload (`sealer.ts`); evie relays the envelope but never sees the op. */
export const FederatedOpSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("send"),
		// The qualified sender (srcGateway/name) for display on the destination.
		from: z.string().min(1).max(128),
		// The BARE local team name on the destination Gateway.
		to: z.string().min(1).max(128),
		request_type: z.string().optional(),
		effort: z.string().optional(),
		body: z.string(),
		files: ChannelFilesSchema.optional(),
		returnRoute: ReturnRouteSchema,
	}),
	// Discovery fan-out: the asking Gateway queries each online peer for its teams.
	z.object({ kind: z.literal("list_teams") }),
	// Wake-across-Gatewayes: bring up a sleeping devcontainer on the destination.
	z.object({ kind: z.literal("wake"), team: z.string().min(1).max(128) }),
	// The destination's reply, pinned home: delivered to `session_id` on the origin.
	z.object({
		kind: z.literal("response_push"),
		session_id: z.string().min(1).max(256),
		status: z.string().optional(),
		response: z.string().optional(),
		replyAsJson: z.record(z.string(), z.unknown()).optional(),
		question: z.string().optional(),
		reason: z.string().optional(),
		files: ChannelFilesSchema.optional(),
	}),
]);

/** A sealed envelope (shared/crypto.ts): an ephemeral X25519 box + Ed25519
 * signature. Carries the sealed FederatedOp on the request leg and a sealed
 * op-result on the reply leg. */
export const SealedEnvelopeSchema = z.object({
	ephemeralPub: z.string(),
	nonce: z.string(),
	ciphertext: z.string(),
	signature: z.string(),
});

/** The gateway_relay payload. Clean cutover: cross-Gateway traffic is ALWAYS E2E-sealed
 * (the plaintext spike's cleartext `op` is retired), so evie sees only this opaque
 * sealed blob - it cannot read or forge the op. */
export const GatewayRelayPayloadSchema = z.object({
	sealed: SealedEnvelopeSchema,
});

/** The full gateway_relay frame the destination gateway's relay pump validates (the
 * loose `gateway_relay` member of EvieInboundFrameSchema parses to this). */
export const GatewayRelayFrameSchema = z.object({
	type: z.literal("gateway_relay"),
	v: z.number().int().positive(),
	relayId: z.string().min(1).max(128),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	payload: GatewayRelayPayloadSchema,
});

////////////////////////////////
//  Types
//
//  Op RESULTS are sealed back to the origin Gateway too (hostRelay.ts seals the reply
//  leg), then parsed loosely by the origin: a peer Gateway is semi-trusted, and the
//  console's tolerant decode plus the existing route validation handle shape, so no
//  result schema is enforced here.

export type ReturnRoute = z.infer<typeof ReturnRouteSchema>;
export type FederatedOp = z.infer<typeof FederatedOpSchema>;
export type FederatedOpKind = FederatedOp["kind"];
export type GatewayRelayPayload = z.infer<typeof GatewayRelayPayloadSchema>;
export type GatewayRelayFrame = z.infer<typeof GatewayRelayFrameSchema>;
