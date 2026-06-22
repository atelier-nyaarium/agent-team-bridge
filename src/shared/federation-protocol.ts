import { z } from "zod";
import { sign, verify } from "./crypto.js";
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
 * used as the job key on BOTH Gateways so neither side has to translate. */
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
	// Wake-across-Gateways: bring up a sleeping devcontainer on the destination.
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
	// The sender's Domain id, stamped by the Router. Lets the open path resolve a
	// cross-Domain peer by the full (domainId, gatewayId) pair. Absent on a frame from a
	// pre-multi-tenant Router; the open path then falls back to the bare-gatewayId scan.
	srcDomain: z.string().min(1).max(64).optional(),
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

////////////////////////////////
//  Cross-Domain link (the gateway-to-gateway trust artifact)
//
//  A cross-Domain link authorizes a gateway-scoped sealed channel between two
//  Gateways owned by DIFFERENT owners (different Domains). It is NOT an admission
//  (admissions are single-owner, intra-Domain) and is NOT a SYNC-HASH leaf - it is
//  switchboard-only gateway-to-gateway vocabulary evie never sees, so it lives here,
//  not in admission.ts.
//
//  Trust is mutual: EACH owner signs its OWN side of the link (binding the friend's
//  owner key + the friend gateway's keys it will seal to), and the peer verifies the
//  received side against the friend owner key it confirmed out of band (the SAS
//  ceremony). The signing bytes mirror admissionSigningBytes EXACTLY in
//  shape: a versioned, newline-joined, fixed-order encoding (every field is base64,
//  a slug, or a decimal int - none can carry a newline), so it reproduces
//  byte-for-byte across runtimes. Do NOT sign raw JSON.

export const XDomainLinkSchema = z
	.object({
		// The signing owner's own root key (base64) - the side that signs this link.
		myOwnerSignPub: z.string().min(1),
		// The friend owner's root key (base64) - the trust anchor the peer verifies under.
		peerOwnerSignPub: z.string().min(1),
		// The friend's Domain id, constrained to the slug grammar (the sanitizeDomainId
		// output) so it can never contain a newline that would make the signing bytes
		// ambiguous against the adjacent peerGatewayId.
		peerDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		// The friend gateway's id (slug; NOT globally unique, so always paired with the
		// Domain). Same slug grammar, so the two adjacent id fields can never merge across
		// the newline join in the signing bytes.
		peerGatewayId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		// The friend gateway's raw Ed25519 signing public key (base64).
		peerSignPub: z.string().min(1),
		// The friend gateway's raw X25519 box public key (base64).
		peerBoxPub: z.string().min(1),
		// Issue time (epoch ms).
		issuedAt: z.number().int().nonnegative(),
		// Single-use random (base64), so a re-issued link is a distinct bytestring.
		nonce: z.string().min(1),
	})
	.meta({ id: "XDomainLink" });

export const SignedXDomainLinkSchema = z
	.object({
		link: XDomainLinkSchema,
		// The owner key that signed this side (informational; the verifier checks it
		// against the expected friend owner key, never trusts this field alone).
		ownerSignPub: z.string().min(1),
		// The signing owner's Ed25519 signature over xDomainLinkSigningBytes (base64).
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainLink" });

export type XDomainLink = z.infer<typeof XDomainLinkSchema>;
export type SignedXDomainLink = z.infer<typeof SignedXDomainLinkSchema>;

/** Versioned, newline-joined signing bytes for a cross-Domain link side. Mirrors
 * `admissionSigningBytes` in shape; the field order is fixed and reproduced
 * byte-for-byte on every runtime. */
export function xDomainLinkSigningBytes(link: XDomainLink): Buffer {
	return Buffer.from(
		[
			"XDOMAIN_LINK_V1",
			link.myOwnerSignPub,
			link.peerOwnerSignPub,
			link.peerDomainId,
			link.peerGatewayId,
			link.peerSignPub,
			link.peerBoxPub,
			String(link.issuedAt),
			link.nonce,
		].join("\n"),
		"utf8",
	);
}

/** Owner-sign one side of a cross-Domain link (the owner device holds the signing key). */
export function signXDomainLink(
	link: XDomainLink,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedXDomainLink {
	return {
		link,
		ownerSignPub: ownerSignPubB64,
		signature: sign(xDomainLinkSigningBytes(link), ownerSignPrivB64),
	};
}

/** True if the link side verifies under the EXPECTED friend owner key. The claimed
 * ownerSignPub must equal the expected key AND the signature must check. */
export function verifyXDomainLink(s: SignedXDomainLink, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(xDomainLinkSigningBytes(s.link), s.signature, expectedOwnerSignPubB64);
}
