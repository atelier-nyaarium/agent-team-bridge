import { z } from "zod";
import { ChannelFilesSchema } from "./evie-protocol.js";

////////////////////////////////
//  Federation inner protocol (arbiter <-> arbiter, via evie)
//
//  evie routes the OUTER envelope (evie-protocol.ts: relayId / srcSwitch / dstSwitch)
//  and never reads the payload. THIS module is the inner vocabulary the two
//  arbiters share and evie does not: the federated op a Switch runs on a peer's
//  behalf, the return-route that pins a reply back to the origin session, and the
//  crypto-aware payload wrapper. It is NOT codegen'd to Kotlin - cross-Switch
//  traffic is arbiter-to-arbiter; the phone reaches the mesh through its home
//  Switch. Re-export `FEDERATION_PROTOCOL_VERSION` from the synced leaf so both the
//  wire version and the inner ops travel from one import surface.

export { FEDERATION_PROTOCOL_VERSION } from "./evie-protocol.js";

////////////////////////////////
//  Schemas

/** How a destination Switch pins a reply back to the originating Switch's exact
 * session. Carried on a cross-Switch `send`, stored on the destination job, and
 * read by `respond` to forward the response_push back across evie. `srcSession`
 * is the origin's channel job key (`conv:<srcConversationId>:<dstSwitch>/<name>`),
 * used as the job key on BOTH Switches so neither side has to translate. */
export const ReturnRouteSchema = z.object({
	srcSwitch: z.string().min(1).max(64),
	srcConversationId: z.string().min(1).max(128),
	srcSession: z.string().min(1).max(256),
});

/** The op a Switch executes on a peer's behalf. Always carried E2E-sealed inside the
 * switch_relay payload (`sealer.ts`); evie relays the envelope but never sees the op. */
export const FederatedOpSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("send"),
		// The qualified sender (srcSwitch/name) for display on the destination.
		from: z.string().min(1).max(128),
		// The BARE local team name on the destination Switch.
		to: z.string().min(1).max(128),
		request_type: z.string().optional(),
		effort: z.string().optional(),
		body: z.string(),
		files: ChannelFilesSchema.optional(),
		returnRoute: ReturnRouteSchema,
	}),
	// Discovery fan-out: the asking Switch queries each online peer for its teams.
	z.object({ kind: z.literal("list_teams") }),
	// Wake-across-Switches: bring up a sleeping devcontainer on the destination.
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

/** The switch_relay payload. Clean cutover: cross-Switch traffic is ALWAYS E2E-sealed
 * (the plaintext spike's cleartext `op` is retired), so evie sees only this opaque
 * sealed blob - it cannot read or forge the op. */
export const SwitchRelayPayloadSchema = z.object({
	sealed: SealedEnvelopeSchema,
});

/** The full switch_relay frame the destination arbiter's relay pump validates (the
 * loose `switch_relay` member of EvieInboundFrameSchema parses to this). */
export const SwitchRelayFrameSchema = z.object({
	type: z.literal("switch_relay"),
	v: z.number().int().positive(),
	relayId: z.string().min(1).max(128),
	srcSwitch: z.string().min(1).max(64),
	dstSwitch: z.string().min(1).max(64),
	payload: SwitchRelayPayloadSchema,
});

////////////////////////////////
//  Types
//
//  Op RESULTS are sealed back to the origin Switch too (hostRelay.ts seals the reply
//  leg), then parsed loosely by the origin: a peer Switch is semi-trusted, and the
//  phone's tolerant decode plus the existing route validation handle shape, so no
//  result schema is enforced here.

export type ReturnRoute = z.infer<typeof ReturnRouteSchema>;
export type FederatedOp = z.infer<typeof FederatedOpSchema>;
export type FederatedOpKind = FederatedOp["kind"];
export type SwitchRelayPayload = z.infer<typeof SwitchRelayPayloadSchema>;
export type SwitchRelayFrame = z.infer<typeof SwitchRelayFrameSchema>;
