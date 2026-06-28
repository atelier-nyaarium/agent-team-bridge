import { z } from "zod";
import { sign, verify } from "./crypto.js";
import { ChannelFilesSchema } from "./evie-protocol.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";

////////////////////////////////
//  Federation inner protocol (gateway <-> gateway, via evie)
//
//  evie routes the OUTER envelope (evie-protocol.ts) and never reads the payload. This
//  module is the inner vocabulary the two gateways share and evie does not. It is NOT
//  codegen'd to Kotlin: cross-Gateway traffic is gateway-to-gateway, and the console
//  reaches the mesh through its route Gateway.

export { FEDERATION_PROTOCOL_VERSION } from "./evie-protocol.js";

////////////////////////////////
//  Schemas

/** How a destination Gateway pins a reply back to the originating Gateway's exact
 * session. `srcSession` is the origin's channel job key
 * (`conv:<srcConversationId>:<dstGateway>/<name>`), used as the job key on BOTH
 * Gateways so neither side has to translate. */
// Worst-case lengths under the dot-address grammar. A flattened store key is
// `conv.<conversationId(<=128)>.<4 slugs(<=64)>` + delimiters (~393); a qualified address is 4
// slugs + dots (~259). Cap with headroom so a fully-qualified key/address never trips validation.
const MAX_STORE_KEY_LEN = 512;
const MAX_ADDRESS_LEN = 320;

export const ReturnRouteSchema = z.object({
	srcGateway: z.string().min(1).max(64),
	srcConversationId: z.string().min(1).max(MAX_CONVERSATION_ID_LEN).regex(CONVERSATION_ID_RE),
	srcSession: z.string().min(1).max(MAX_STORE_KEY_LEN),
});

/** The op a Gateway executes on a peer's behalf. Always carried E2E-sealed inside the
 * gateway_relay payload (`sealer.ts`); evie relays the envelope but never sees the op. */
export const FederatedOpSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("send"),
		// The qualified sender address (domain.gateway.spawn.session) for display on the destination.
		from: z.string().min(1).max(MAX_ADDRESS_LEN),
		// The local team field (spawn.session) on the destination Gateway.
		to: z.string().min(1).max(MAX_ADDRESS_LEN),
		request_type: z.string().optional(),
		effort: z.string().optional(),
		body: z.string(),
		files: ChannelFilesSchema.optional(),
		returnRoute: ReturnRouteSchema,
	}),
	// Discovery fan-out: the asking Gateway queries each online peer for its teams.
	z.object({ kind: z.literal("list_teams") }),
	// Wake-across-Gateways: bring up a sleeping devcontainer on the destination.
	z.object({ kind: z.literal("wake"), team: z.string().min(1).max(MAX_ADDRESS_LEN) }),
	// The destination's reply, pinned to the origin: delivered to `session_id` on the origin.
	z.object({
		kind: z.literal("response_push"),
		session_id: z.string().min(1).max(MAX_STORE_KEY_LEN),
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

/** The gateway_relay payload. Cross-Gateway traffic is ALWAYS E2E-sealed, so evie sees
 * only this opaque sealed blob and cannot read or forge the op. */
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
//  Op RESULTS are sealed back to the origin Gateway too (gatewayRelay.ts seals the reply
//  leg), then parsed loosely by the origin: a peer Gateway is semi-trusted, and the
//  existing route validation handles shape, so no result schema is enforced here.

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

////////////////////////////////
//  Untrust tombstone (withdraw trust in a friend OWNER)
//
//  The Users-surface "Untrust" revokes trust in a PERSON (an owner), not one gateway, so the
//  tombstone is keyed by the two OWNER roots only - dropping ANY trust link to that owner whatever
//  gateway it bound. Signed by MY owner key (only I can withdraw my own trust) and verified under
//  it. `revokedAt` is the floor: a trust link issued at or before it is dead (so a replayed stale
//  link cannot re-establish trust), while a genuine re-trust (a fresh link issued AFTER the
//  revoke) is honored. Gateway-persisted like the link itself; evie never sees it.

export const XDomainUntrustSchema = z
	.object({
		// The owner withdrawing trust (the signer).
		myOwnerSignPub: z.string().min(1),
		// The friend owner being untrusted (the trust is dropped for every gateway under this root).
		peerOwnerSignPub: z.string().min(1),
		// Revoke time (epoch ms); the floor that nullifies any trust link issued at or before it.
		revokedAt: z.number().int().nonnegative(),
		// Single-use random (base64), so a re-issued untrust is a distinct bytestring.
		nonce: z.string().min(1),
	})
	.meta({ id: "XDomainUntrust" });

export const SignedXDomainUntrustSchema = z
	.object({
		untrust: XDomainUntrustSchema,
		// The owner key that signed this untrust (checked against the local owner root, never trusted alone).
		ownerSignPub: z.string().min(1),
		// The owner's Ed25519 signature over xDomainUntrustSigningBytes (base64).
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainUntrust" });

export type XDomainUntrust = z.infer<typeof XDomainUntrustSchema>;
export type SignedXDomainUntrust = z.infer<typeof SignedXDomainUntrustSchema>;

/** Versioned, newline-joined signing bytes for an untrust tombstone. Same shape discipline as
 * `xDomainLinkSigningBytes` (every field base64/decimal, no newline can sneak in). */
export function xDomainUntrustSigningBytes(u: XDomainUntrust): Buffer {
	return Buffer.from(
		["XDOMAIN_UNTRUST_V1", u.myOwnerSignPub, u.peerOwnerSignPub, String(u.revokedAt), u.nonce].join("\n"),
		"utf8",
	);
}

/** Owner-sign an untrust tombstone (the owner device holds the signing key). */
export function signXDomainUntrust(
	untrust: XDomainUntrust,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedXDomainUntrust {
	return {
		untrust,
		ownerSignPub: ownerSignPubB64,
		signature: sign(xDomainUntrustSigningBytes(untrust), ownerSignPrivB64),
	};
}

/** True if the untrust verifies under the EXPECTED owner key (the local owner root - only that key
 * may withdraw its own trust). The claimed ownerSignPub must equal it AND the signature must check. */
export function verifyXDomainUntrust(s: SignedXDomainUntrust, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(xDomainUntrustSigningBytes(s.untrust), s.signature, expectedOwnerSignPubB64);
}
