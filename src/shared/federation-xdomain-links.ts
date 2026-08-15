import { z } from "zod";
import { sign, verify } from "./crypto.js";

////////////////////////////////
//  Schemas

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
 * attestation that traffic from `srcDomainId` may relay to `dstDomainId`. evie drops every
 * matching edge for the pair, so its relay-affinity gate refuses the cross-Domain
 * `gateway_relay` again. Content-blind and slug-constrained like the edge it revokes; the
 * shape adds the admission Revocation's revoke-time/nonce fields. */
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

export type XDomainLinkEdge = z.infer<typeof XDomainLinkEdgeSchema>;
export type SignedXDomainLinkEdge = z.infer<typeof SignedXDomainLinkEdgeSchema>;
export type XDomainLinkRevocation = z.infer<typeof XDomainLinkRevocationSchema>;
export type SignedXDomainLinkRevocation = z.infer<typeof SignedXDomainLinkRevocationSchema>;

////////////////////////////////
//  Functions & Helpers

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
