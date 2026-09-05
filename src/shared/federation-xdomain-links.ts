import { z } from "zod";
import { sign, verify } from "./crypto.js";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

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
		ownerSignPub: z.string().min(1),
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainLinkEdge" });

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
		ownerSignPub: z.string().min(1),
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainLinkRevocation" });

export type XDomainLinkEdge = z.infer<typeof XDomainLinkEdgeSchema>;
export type SignedXDomainLinkEdge = z.infer<typeof SignedXDomainLinkEdgeSchema>;
export type XDomainLinkRevocation = z.infer<typeof XDomainLinkRevocationSchema>;
export type SignedXDomainLinkRevocation = z.infer<typeof SignedXDomainLinkRevocationSchema>;

export function xDomainLinkEdgeSigningBytes(edge: XDomainLinkEdge, ownerSignPubB64: string): Buffer {
	// Signing bytes must match Android byte-for-byte.
	return Buffer.from(
		[
			SIGNING_TAGS.xdomainRelayGate,
			ownerSignPubB64,
			edge.srcDomainId,
			edge.dstDomainId,
			String(edge.issuedAt),
			edge.nonce,
		].join("\n"),
		"utf8",
	);
}

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

export function verifyXDomainLinkEdge(s: SignedXDomainLinkEdge, expectedOwnerSignPubB64: string): boolean {
	// Verify the rooted source-Domain owner key.
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(xDomainLinkEdgeSigningBytes(s.edge, expectedOwnerSignPubB64), s.signature, expectedOwnerSignPubB64);
}

export function xDomainLinkRevocationSigningBytes(rev: XDomainLinkRevocation, ownerSignPubB64: string): Buffer {
	// Distinct tags prevent edge-revocation replay.
	return Buffer.from(
		[
			SIGNING_TAGS.xdomainRevoke,
			ownerSignPubB64,
			rev.srcDomainId,
			rev.dstDomainId,
			String(rev.revokedAt),
			rev.nonce,
		].join("\n"),
		"utf8",
	);
}

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

export function verifyXDomainLinkRevocation(s: SignedXDomainLinkRevocation, expectedOwnerSignPubB64: string): boolean {
	// Verify the rooted source-Domain owner key.
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(
		xDomainLinkRevocationSigningBytes(s.revocation, expectedOwnerSignPubB64),
		s.signature,
		expectedOwnerSignPubB64,
	);
}
