import { z } from "zod";
import type { CrossDomainParty } from "../../shared/cross-domain-sas.js";

////////////////////////////////
//  Cross-Domain handshake wire protocol
//
//  The commit-reveal wire shapes that cross the Router between a requester and receiver
//  Gateway, the zod schemas that validate them at the boundary, and the token/salt sizing
//  that shapes them. Kept separate from crossDomainHandshake.ts so the wire format can be
//  read without the coordinator state machine that drives it.

////////////////////////////////
//  Interfaces & Types

/** Round 1, requester -> receiver: the rendezvous token + pin + the requester's hiding
 * commitment. No keys revealed yet (the commitment binds them). */
export interface XDomainCommitWire {
	listeningToken: string;
	pin: string;
	requesterCommitment: string;
}

/** Round 1 reply, receiver -> requester: the receiver's own hiding commitment, formed
 * having seen ONLY the requester's commitment. */
export interface XDomainCommitReplyWire {
	receiverCommitment: string;
}

/** Round 2, requester -> receiver: the requester's revealed keys+ids + the salt that
 * un-hides its round-1 commitment. The receiver checks it reproduces Ha before the SAS. */
export interface XDomainRevealWire {
	listeningToken: string;
	pin: string;
	requesterParty: CrossDomainParty;
	requesterSalt: string;
}

/** Round 2 reply, receiver -> requester: the receiver's revealed keys+ids + salt (must
 * reproduce Hb) plus the SAS over both committed parties + the pin. */
export interface XDomainRevealReplyWire {
	receiverParty: CrossDomainParty;
	receiverSalt: string;
	sas: string;
}

////////////////////////////////
//  Schemas

/** Boundary validation for an inbound round-1 commit frame (the opaque `payload` the Router
 * relays verbatim), parsed before `handleIncomingCommit` so a malformed frame is rejected. */
export const XDomainCommitWireSchema = z.object({
	listeningToken: z.string().min(1).max(256),
	pin: z.string().min(1).max(256),
	requesterCommitment: z.string().min(1).max(256),
});

const CrossDomainPartySchema = z.object({
	ownerSignPub: z.string().min(1),
	gatewaySignPub: z.string().min(1),
	gatewayBoxPub: z.string().min(1),
	domainId: z.string().min(1).max(64),
	gatewayId: z.string().min(1).max(64),
});

/** Boundary validation for an inbound round-2 reveal frame. */
export const XDomainRevealWireSchema = z.object({
	listeningToken: z.string().min(1).max(256),
	pin: z.string().min(1).max(256),
	requesterParty: CrossDomainPartySchema,
	requesterSalt: z.string().min(1).max(256),
});

const XDomainCommitReplyWireSchema = z.object({
	receiverCommitment: z.string().min(1).max(256),
});

const XDomainRevealReplyWireSchema = z.object({
	receiverParty: CrossDomainPartySchema,
	receiverSalt: z.string().min(1).max(256),
	sas: z.string().min(1),
});

/** Parse + validate a receiver Gateway's round-1 commit reply (the opaque `result` of
 * the held call). Throws on a malformed reply so the requester leg fails fast. */
export function parseCommitReply(raw: unknown): XDomainCommitReplyWire {
	return XDomainCommitReplyWireSchema.parse(raw);
}

/** Parse + validate a receiver Gateway's round-2 reveal reply. Throws on a malformed
 * reply so the requester does not cross-check a forged shape. */
export function parseRevealReply(raw: unknown): XDomainRevealReplyWire {
	return XDomainRevealReplyWireSchema.parse(raw);
}

////////////////////////////////
//  Constants

// The random tail of a listening token: 18 bytes base64url, matching the enrollment nonce.
export const TOKEN_RANDOM_BYTES = 18;

// Per-side commitment salt: 18 random bytes base64url, hiding the (public) committed keys so the
// commitment is binding without being guessable.
export const SALT_RANDOM_BYTES = 18;

////////////////////////////////
//  Functions & Helpers

/** Parse a listening token `<gatewayId>.<random>` into its receiver Gateway id (the prefix
 * lets the requester route without a lookup). Returns null when the token has no separator. */
export function parseListeningToken(token: string): { gatewayId: string } | null {
	const i = token.indexOf(".");
	if (i <= 0) return null;
	return { gatewayId: token.slice(0, i) };
}
