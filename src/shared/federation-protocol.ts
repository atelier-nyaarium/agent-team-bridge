import { z } from "zod";
import { ChannelFilesSchema } from "./evie-protocol.js";
import { TeamInfoSchema } from "./schemas.js";

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

/** The op a Host executes on a peer's behalf. Plaintext spike: travels in the
 * clear inside the host_relay payload; the crypto phase moves it inside `sealed`. */
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

/** The host_relay payload, crypto-aware. Plaintext spike: `op` carries the
 * cleartext federated op. Crypto phase: `op` is absent and {sealed, nonce} carry
 * the sealed op (the fields are reserved now so the format never re-freezes). */
export const HostRelayPayloadSchema = z.object({
	op: FederatedOpSchema.optional(),
	sealed: z.string().optional(),
	nonce: z.string().optional(),
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
//  Op result schemas (destination -> origin, in host_relay_reply.result)

export const FederatedSendResultSchema = z.object({
	session_id: z.string(),
	status: z.string(),
});

export const FederatedListTeamsResultSchema = z.object({
	teams: z.array(TeamInfoSchema),
});

export const FederatedAckResultSchema = z.object({
	ok: z.boolean(),
});

////////////////////////////////
//  Types

export type ReturnRoute = z.infer<typeof ReturnRouteSchema>;
export type FederatedOp = z.infer<typeof FederatedOpSchema>;
export type FederatedOpKind = FederatedOp["kind"];
export type HostRelayPayload = z.infer<typeof HostRelayPayloadSchema>;
export type HostRelayFrame = z.infer<typeof HostRelayFrameSchema>;
export type FederatedSendResult = z.infer<typeof FederatedSendResultSchema>;
export type FederatedListTeamsResult = z.infer<typeof FederatedListTeamsResultSchema>;
export type FederatedAckResult = z.infer<typeof FederatedAckResultSchema>;
