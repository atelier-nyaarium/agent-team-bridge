import { z } from "zod";
import { ChannelFilesSchema } from "./evie-protocol.js";

////////////////////////////////
//  Federation inner protocol (arbiter <-> arbiter, via evie)
//
//  evie routes the OUTER envelope (evie-protocol.ts: relayId / srcHost / dstHost)
//  and never reads the payload. THIS module is the inner vocabulary the two
//  arbiters share and evie does not: the federated op a Host runs on a peer's
//  behalf, the return-route that pins a reply back to the origin session, and the
//  crypto-aware payload wrapper. It is NOT codegen'd to Kotlin - cross-Host
//  traffic is arbiter-to-arbiter; the phone reaches the mesh through its home
//  Host. Re-export `FEDERATION_PROTOCOL_VERSION` from the synced leaf so both the
//  wire version and the inner ops travel from one import surface.

export { FEDERATION_PROTOCOL_VERSION } from "./evie-protocol.js";

////////////////////////////////
//  Schemas

/** How a destination Host pins a reply back to the originating Host's exact
 * session. Carried on a cross-Host `send`, stored on the destination job, and
 * read by `respond` to forward the response_push back across evie. `srcSession`
 * is the origin's channel job key (`conv:<srcConversationId>:<dstHost>/<name>`),
 * used as the job key on BOTH Hosts so neither side has to translate. */
export const ReturnRouteSchema = z.object({
	srcHost: z.string().min(1).max(64),
	srcConversationId: z.string().min(1).max(128),
	srcSession: z.string().min(1).max(256),
});

/** The op a Host executes on a peer's behalf. Always carried E2E-sealed inside the
 * host_relay payload (`sealer.ts`); evie relays the envelope but never sees the op. */
export const FederatedOpSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("send"),
		// The qualified sender (srcHost/name) for display on the destination.
		from: z.string().min(1).max(128),
		// The BARE local team name on the destination Host.
		to: z.string().min(1).max(128),
		request_type: z.string().optional(),
		effort: z.string().optional(),
		body: z.string(),
		files: ChannelFilesSchema.optional(),
		returnRoute: ReturnRouteSchema,
	}),
	// Discovery fan-out: the asking Host queries each online peer for its teams.
	z.object({ kind: z.literal("list_teams") }),
	// Wake-across-Hosts: bring up a sleeping devcontainer on the destination.
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

/** The host_relay payload. Clean cutover: cross-Host traffic is ALWAYS E2E-sealed
 * (the plaintext spike's cleartext `op` is retired), so evie sees only this opaque
 * sealed blob - it cannot read or forge the op. */
export const HostRelayPayloadSchema = z.object({
	sealed: SealedEnvelopeSchema,
});

/** The full host_relay frame the destination arbiter's relay pump validates (the
 * loose `host_relay` member of EvieInboundFrameSchema parses to this). */
export const HostRelayFrameSchema = z.object({
	type: z.literal("host_relay"),
	v: z.number().int().positive(),
	relayId: z.string().min(1).max(128),
	srcHost: z.string().min(1).max(64),
	dstHost: z.string().min(1).max(64),
	payload: HostRelayPayloadSchema,
});

////////////////////////////////
//  Types
//
//  Op RESULTS are sealed back to the origin Host too (hostRelay.ts seals the reply
//  leg), then parsed loosely by the origin: a peer Host is semi-trusted, and the
//  phone's tolerant decode plus the existing route validation handle shape, so no
//  result schema is enforced here.

export type ReturnRoute = z.infer<typeof ReturnRouteSchema>;
export type FederatedOp = z.infer<typeof FederatedOpSchema>;
export type FederatedOpKind = FederatedOp["kind"];
export type HostRelayPayload = z.infer<typeof HostRelayPayloadSchema>;
export type HostRelayFrame = z.infer<typeof HostRelayFrameSchema>;
