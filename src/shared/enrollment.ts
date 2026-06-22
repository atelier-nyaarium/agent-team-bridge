// SYNC-HASH: 4cf3b8fadcb86483795a7dd0b2af2df1
// SYNCED MODULE - source of truth: switchboard/src/shared/enrollment.ts
// Copied verbatim into: evie-bot/app/features/bridge/enrollment.ts
// MUST re-copy on change: cp src/shared/enrollment.ts ../evie-bot/app/features/bridge/enrollment.ts
import { z } from "zod";
import {
	type Admission,
	type SignedAdmission,
	SignedAdmissionSchema,
	SignedRevocationSchema,
	signAdmission,
} from "./admission.js";
import { fingerprint, sign, verify } from "./crypto.js";

////////////////////////////////
//  Enrollment payloads (the unified QR) + the SAS confirm
//
//  One Android scanner decodes a TYPE-tagged payload and routes by type. Three
//  flows, each anti-MITM via a short-authentication-string (SAS): the same key
//  fingerprint is shown on the scanner AND out-of-band (the gateway's console /
//  the evie admin terminal), and the human confirms they match - a relayed or
//  screenshotted QR cannot forge the out-of-band side.
//
//  - enroll-owner: evie admin command -> owner console. Roots the owner device at
//    the Domain; the owner confirms evie's signing fingerprint from the terminal.
//  - admit-gateway: an gateway -> owner console. The owner confirms the Gateway
//    fingerprint on the gateway console, then signs an admission for it.
//  - authorize-console: owner console -> a second owner device.

////////////////////////////////
//  Schemas

const ServiceBundleSchema = z.object({
	// Reach-evie basics + service keys the wizard delivers (never hand-pasted).
	evieAddr: z.string().optional(),
	transportToken: z.string().optional(),
	sttsUrl: z.string().optional(),
	sttsKey: z.string().optional(),
});

export const EnrollmentPayloadSchema = z
	.discriminatedUnion("type", [
		z.object({
			type: z.literal("enroll-owner"),
			domainId: z.string().min(1),
			evieAddr: z.string().min(1),
			evieSignPub: z.string().min(1),
			evieBoxPub: z.string().min(1),
			// Single-use, tight-TTL nonce redeemed once at evie (anti-replay R1).
			nonce: z.string().min(1),
			bundle: ServiceBundleSchema.optional(),
		}),
		z.object({
			type: z.literal("admit-gateway"),
			gatewayId: z.string().min(1),
			signPub: z.string().min(1),
			boxPub: z.string().min(1),
			// Where the Console delivers the sealed bootstrap bundle. Present when the
			// Gateway opened a LAN listener; absent when the operator chose manual paste.
			lan: z.object({ host: z.string().min(1), port: z.number().int().positive() }).optional(),
			// One-time nonce gating that listener; the Console echoes it inside the sealed
			// bundle so a stale or cross-window delivery is rejected.
			nonce: z.string().min(1).optional(),
		}),
		z.object({
			type: z.literal("authorize-console"),
			domainId: z.string().min(1),
			signPub: z.string().min(1),
			boxPub: z.string().min(1),
		}),
	])
	.meta({ id: "EnrollmentPayload" });

/** A content-blind cross-Domain link edge: an owner attests that traffic from its
 * Domain (`srcDomainId`) may relay to a friend Domain (`dstDomainId`) it has linked
 * with. evie's relay-affinity gate honors a cross-Domain `gateway_relay` only when such
 * an owner-signed edge exists for the pair. Content-blind: it names only the two Domain
 * ids, never a session or a key. Both ids are slug-constrained so neither can carry a
 * newline that would make the signing bytes ambiguous against the other. */
export const XDomainLinkEdgeSchema = z
	.object({
		srcDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		dstDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		issuedAt: z.number().int().nonnegative(),
		nonce: z.string().min(1),
	})
	.meta({ id: "XDomainLinkEdge" });

export const SignedXDomainLinkEdgeSchema = z
	.object({
		edge: XDomainLinkEdgeSchema,
		// The linking owner's root key (base64). evie checks it against the srcDomain's
		// rooted owner key (the owner of the Domain the edge authorizes traffic FROM),
		// never trusting this field alone.
		ownerSignPub: z.string().min(1),
		// The owner's Ed25519 signature over xDomainLinkEdgeSigningBytes (base64).
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainLinkEdge" });

/** The owner-signed revocation of a cross-Domain link edge: it withdraws the owner's
 * attestation that traffic from its Domain (`srcDomainId`) may relay to a friend Domain
 * (`dstDomainId`). evie drops every matching edge for the pair, so its relay-affinity gate
 * refuses the cross-Domain `gateway_relay` again. Content-blind: it names only the two
 * Domain ids, never a session or a key, and both ids are slug-constrained so neither can
 * carry a newline that would make the signing bytes ambiguous against the other. The shape
 * mirrors the edge it revokes plus the admission Revocation's revoke-time/nonce fields. */
export const XDomainLinkRevocationSchema = z
	.object({
		srcDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		dstDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		revokedAt: z.number().int().nonnegative(),
		nonce: z.string().min(1),
	})
	.meta({ id: "XDomainLinkRevocation" });

export const SignedXDomainLinkRevocationSchema = z
	.object({
		revocation: XDomainLinkRevocationSchema,
		// The revoking owner's root key (base64). evie checks it against the srcDomain's
		// rooted owner key (the owner of the Domain whose edge is being revoked), never
		// trusting this field alone.
		ownerSignPub: z.string().min(1),
		// The owner's Ed25519 signature over xDomainLinkRevocationSigningBytes (base64).
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainLinkRevocation" });

/** The owner device's enrollment requests to evie (NOT relayed to a Gateway - evie
 * is the Domain root). All are self-authenticating: `enroll_redeem` is authorized by
 * the single-use nonce evie minted, and the submit ops carry an owner-signed artifact
 * evie verifies against the rooted owner key. The console sends them over the same
 * app-token-gated bridge as its gateway ops. */
export const EnrollOpSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("enroll_redeem"),
			nonce: z.string().min(1),
			ownerSignPub: z.string().min(1),
			ownerBoxPub: z.string().min(1),
		}),
		z.object({ kind: z.literal("submit_admission"), admission: SignedAdmissionSchema }),
		z.object({ kind: z.literal("submit_revocation"), revocation: SignedRevocationSchema }),
		z.object({ kind: z.literal("submit_xdomain_link"), edge: SignedXDomainLinkEdgeSchema }),
		z.object({ kind: z.literal("revoke_xdomain_link"), revocation: SignedXDomainLinkRevocationSchema }),
	])
	.meta({ id: "EnrollOp" });

/** evie's reply to an enroll op. */
export const EnrollResultSchema = z
	.object({ ok: z.boolean(), error: z.string().optional() })
	.meta({ id: "EnrollResult" });

export type EnrollmentPayload = z.infer<typeof EnrollmentPayloadSchema>;
export type EnrollOwnerPayload = Extract<EnrollmentPayload, { type: "enroll-owner" }>;
export type AdmitGatewayPayload = Extract<EnrollmentPayload, { type: "admit-gateway" }>;
export type AuthorizeConsolePayload = Extract<EnrollmentPayload, { type: "authorize-console" }>;
export type EnrollOp = z.infer<typeof EnrollOpSchema>;
export type EnrollResult = z.infer<typeof EnrollResultSchema>;
export type XDomainLinkEdge = z.infer<typeof XDomainLinkEdgeSchema>;
export type SignedXDomainLinkEdge = z.infer<typeof SignedXDomainLinkEdgeSchema>;
export type XDomainLinkRevocation = z.infer<typeof XDomainLinkRevocationSchema>;
export type SignedXDomainLinkRevocation = z.infer<typeof SignedXDomainLinkRevocationSchema>;

////////////////////////////////
//  Functions & Helpers

/** The short authentication string for a scanned payload: the fingerprint of the
 * signing key the human confirms out-of-band before trusting the scan. */
export function payloadSas(payload: EnrollmentPayload): string {
	switch (payload.type) {
		case "enroll-owner":
			return fingerprint(payload.evieSignPub);
		case "admit-gateway":
		case "authorize-console":
			return fingerprint(payload.signPub);
	}
}

/** Build the owner-signed admission for a scanned admit-gateway / authorize-console
 * payload, AFTER the human has confirmed the SAS. `nowMs` + `nonce` are passed in
 * (the caller owns time + randomness). */
export function admissionFromScan(
	payload: AdmitGatewayPayload | AuthorizeConsolePayload,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
	nowMs: number,
	nonceB64: string,
): SignedAdmission {
	const admission: Admission =
		payload.type === "admit-gateway"
			? {
					kind: "gateway",
					signPub: payload.signPub,
					boxPub: payload.boxPub,
					gatewayId: payload.gatewayId,
					issuedAt: nowMs,
					nonce: nonceB64,
				}
			: { kind: "console", signPub: payload.signPub, boxPub: payload.boxPub, issuedAt: nowMs, nonce: nonceB64 };
	return signAdmission(admission, ownerSignPrivB64, ownerSignPubB64);
}

/** Versioned, newline-joined signing bytes for a cross-Domain link edge. Mirrors
 * `admissionSigningBytes` in shape; every field is base64 or a slug, so the encoding is
 * unambiguous and reproduces byte-for-byte on switchboard, evie, and Android. Do NOT
 * sign raw JSON. */
export function xDomainLinkEdgeSigningBytes(edge: XDomainLinkEdge, ownerSignPubB64: string): Buffer {
	return Buffer.from(
		[
			"XDOMAIN_RELAY_GATE_V1",
			ownerSignPubB64,
			edge.srcDomainId,
			edge.dstDomainId,
			String(edge.issuedAt),
			edge.nonce,
		].join("\n"),
		"utf8",
	);
}

/** Owner-sign a cross-Domain link edge (the owner device holds the signing key). */
export function signXDomainLinkEdge(
	edge: XDomainLinkEdge,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedXDomainLinkEdge {
	return {
		edge,
		ownerSignPub: ownerSignPubB64,
		signature: sign(xDomainLinkEdgeSigningBytes(edge, ownerSignPubB64), ownerSignPrivB64),
	};
}

/** True if the link edge verifies under the EXPECTED owner key (the rooted owner of the
 * edge's srcDomain). The claimed ownerSignPub must equal the expected key AND the
 * signature must check. */
export function verifyXDomainLinkEdge(s: SignedXDomainLinkEdge, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(xDomainLinkEdgeSigningBytes(s.edge, expectedOwnerSignPubB64), s.signature, expectedOwnerSignPubB64);
}

/** Versioned, newline-joined signing bytes for a cross-Domain link-edge revocation.
 * The prefix is distinct from the link edge's, so a captured edge signature can never be
 * replayed as a revocation (or the reverse). Every field is base64 or a slug, so the
 * encoding is unambiguous and reproduces byte-for-byte on switchboard, evie, and Android.
 * Do NOT sign raw JSON. */
export function xDomainLinkRevocationSigningBytes(rev: XDomainLinkRevocation, ownerSignPubB64: string): Buffer {
	return Buffer.from(
		["XDOMAIN_REVOKE_V1", ownerSignPubB64, rev.srcDomainId, rev.dstDomainId, String(rev.revokedAt), rev.nonce].join(
			"\n",
		),
		"utf8",
	);
}

/** Owner-sign a cross-Domain link-edge revocation (the owner device holds the signing key). */
export function signXDomainLinkRevocation(
	rev: XDomainLinkRevocation,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedXDomainLinkRevocation {
	return {
		revocation: rev,
		ownerSignPub: ownerSignPubB64,
		signature: sign(xDomainLinkRevocationSigningBytes(rev, ownerSignPubB64), ownerSignPrivB64),
	};
}

/** True if the revocation verifies under the EXPECTED owner key (the rooted owner of the
 * revocation's srcDomain). The claimed ownerSignPub must equal the expected key AND the
 * signature must check. */
export function verifyXDomainLinkRevocation(s: SignedXDomainLinkRevocation, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(
		xDomainLinkRevocationSigningBytes(s.revocation, expectedOwnerSignPubB64),
		s.signature,
		expectedOwnerSignPubB64,
	);
}
