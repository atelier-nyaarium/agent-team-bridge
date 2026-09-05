import type { Ambient } from "../../shared/ambient.js";
import type {
	XDomainCommitReplyWire,
	XDomainCommitWire,
	XDomainRevealReplyWire,
	XDomainRevealWire,
} from "./crossDomainHandshakeWire.js";
import type { CrossDomainPeers } from "./crossDomainPeers.js";

////////////////////////////////
//  Cross-Domain handshake coordinator types
//
//  The shapes the CrossDomainHandshakeCoordinator is built from and holds internally: the
//  Router routing seam and this Gateway's own identity it is constructed with, the
//  constructor deps bag, and the session-state it keeps between round trips (pairing,
//  receiver commit, listening window). Kept separate from crossDomainHandshake.ts so the
//  coordinator's own shape can be read apart from its behavior.

////////////////////////////////
//  Interfaces & Types

/** The Router routing seam: drive each round trip to the receiver Gateway (named by the
 * token prefix) and await its reply. Injected so this coordinator never imports the Router. */
export interface CrossDomainRouter {
	sendCommit(receiverGatewayId: string, req: XDomainCommitWire): Promise<XDomainCommitReplyWire>;
	sendReveal(receiverGatewayId: string, req: XDomainRevealWire): Promise<XDomainRevealReplyWire>;
}

/** This Gateway's own identity for the handshake: the phone-held owner root key (public only)
 * plus this Gateway's keys + ids. The owner signs the link on the phone, so the gateway holds
 * only the public owner key, used to compute the SAS and verify its own signed link. */
export interface CrossDomainSelf {
	ownerSignPub: () => string | null;
	gatewaySignPub: string;
	gatewayBoxPub: string;
	domainId: string;
	gatewayId: string;
}

/** A paired session (either role), keyed by pin. Confirm only needs the FRIEND's keys (to
 * verify the link and store the peer), which is exactly what a pairing holds. */
export interface Pairing {
	friendOwnerSignPub: string;
	friendDomainId: string;
	friendGatewayId: string;
	friendGatewaySignPub: string;
	friendGatewayBoxPub: string;
	sas: string;
	expiresAt: number;
}

/** Receiver round-1 state held between the commit and reveal rounds: the commitments
 * exchanged plus this side's salt. The friend's keys arrive only at reveal. */
export interface ReceiverCommit {
	pin: string;
	requesterCommitment: string;
	receiverSalt: string;
	receiverCommitment: string;
}

/** A receiver-side listening window. */
export interface ListeningSession {
	token: string;
	expiresAt: number;
	// Total pairing attempts against this token; capped to bound brute force.
	attempts: number;
	// Set by round 1 (single-flight: a second commit is rejected once present).
	commit?: ReceiverCommit;
	// Set by round 2 once the requester reveal verifies against the commitment.
	pairing?: Pairing;
}

export interface CrossDomainHandshakeDeps {
	self: CrossDomainSelf;
	peers: CrossDomainPeers;
	/** The Router routing seam (requester role). Absent when the Router is not wired, in
	 * which case `request` errors instead of routing. */
	route?: CrossDomainRouter;
	/** Listening-window TTL (default 1 hour). */
	ttlMs?: number;
	/** Hard cap on pairing attempts per listening token before it is invalidated. */
	maxAttempts?: number;
	ambient: Pick<Ambient, "now" | "randomBytes">;
}

////////////////////////////////
//  Constants

// Intentionally long (1 hour) so a friend installing the app from scratch does not time out
// mid-pairing. Leaving the pairing screen still cancels it.
export const DEFAULT_TTL_MS = 3_600_000;

// Per-token cap on pairing attempts; on cap-exceeded the token + pairing are invalidated and the
// owner must re-listen. A fresh listen() resets the counter, so this caps SAS guesses per window,
// not per requester-owner relationship.
export const DEFAULT_MAX_ATTEMPTS = 5;
