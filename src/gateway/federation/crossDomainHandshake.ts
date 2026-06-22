import { randomBytes } from "node:crypto";
import { z } from "zod";
import type {
	CrossDomainConfirmResult,
	CrossDomainListenResult,
	CrossDomainListenStateResult,
	CrossDomainRequestResult,
} from "../../shared/console-protocol.js";
import {
	type CrossDomainParty,
	crossDomainCommitment,
	crossDomainSas,
	verifyCrossDomainCommitment,
} from "../../shared/cross-domain-sas.js";
import type {
	CrossDomainHandshakeReplyParams,
	CrossDomainHandshakeRevealReplyParams,
} from "../../shared/evie-protocol.js";
import type { SignedXDomainLink } from "../../shared/federation-protocol.js";
import { verifyXDomainLink } from "../../shared/federation-protocol.js";
import type { CrossDomainPeer, CrossDomainPeers } from "./crossDomainPeers.js";

////////////////////////////////
//  Cross-Domain listening-mode handshake (cross-domain-federation.md)
//
//  The mutual both-present pairing that establishes a persistent cross-Domain trust
//  link between two Gateways owned by DIFFERENT owners. This coordinator owns the
//  GATEWAY-side state (the listening window, the requester-minted pin pairing, the
//  attempt cap, the commit-reveal SAS exchange) and is the ONLY writer of the disjoint
//  CrossDomainPeers store. It does NOT route over the Router itself: a Gateway reaches
//  the other Gateway through an injected `route` seam (the Router wiring is a separate
//  slice), and a receiver Gateway feeds inbound relayed frames in via
//  `handleIncomingCommit` / `handleIncomingReveal`.
//
//  The exchange is COMMIT-REVEAL so the content-blind Router cannot offline-grind the
//  SAS. Each side first publishes a hiding commitment to its own keys+ids+salt, then
//  reveals them; a reveal that does not reproduce the earlier commitment aborts. Because
//  each side is committed BEFORE the other reveals, the Router cannot substitute keys and
//  search for a colliding short code: it must pick its substitution before it learns the
//  peer's, collapsing the attack to a single online 1-in-10^12 guess bounded by the
//  attempt cap. The SAS is computed over the COMMITTED keys + both sides' ids + the pin.
//
//  Two round trips, both content-blind through the Router:
//   1. commit:  requester -> receiver  (Ha) ; receiver -> requester  (Hb)
//   2. reveal:  requester -> receiver  (A keys+salt) ; receiver -> requester (B keys+salt+SAS)
//
//  Roles:
//  - LISTENER (receiver): opens a window (`listen`), mints a single-use listening token,
//    accepts ONE pairing bound to that token (`handleIncomingCommit` then
//    `handleIncomingReveal`), and on the human's SAS match writes the friend as a peer
//    (`confirm`). It accepts frames ONLY while its window is open + the token matches, so
//    there is no unsolicited surface.
//  - REQUESTER: pairs against the other side's token (`request`), driving both round trips
//    to the receiver Gateway through the `route` seam, then on the human's SAS match writes
//    the friend as a peer (`confirm`).
//
//  Both confirms are INDEPENDENT and symmetric: each owner signs ONE link attesting the OTHER's
//  keys (which both sides hold from the SAS-verified reveal), and each Gateway stores its OWN
//  owner's attestation - no cross-Gateway link exchange, because the seal only uses the friend's
//  box key from the pairing, so whose signature is on the stored link does not affect seal
//  security. The pin pairs the two listening sessions; the SAS - over both committed parties + the
//  pin - is the residual anti-MITM detector once the commitment closes the grind.

////////////////////////////////
//  Interfaces & Types

/** Round 1, requester -> receiver: the rendezvous token + pin + the requester's hiding
 * commitment (no keys revealed). The Router relays it opaquely; the commitment makes the
 * SAS grind impossible, so this carries no keys and is not the trust root. */
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
 * un-hides its round-1 commitment. The receiver checks it reproduces the committed Ha
 * before computing the SAS. */
export interface XDomainRevealWire {
	listeningToken: string;
	pin: string;
	requesterParty: CrossDomainParty;
	requesterSalt: string;
}

/** Round 2 reply, receiver -> requester: the receiver's revealed keys+ids + salt (which
 * must reproduce Hb) plus the SAS the receiver computed over both committed parties + the
 * pin. The requester verifies the reveal against Hb and recomputes the SAS as a cross-check. */
export interface XDomainRevealReplyWire {
	receiverParty: CrossDomainParty;
	receiverSalt: string;
	sas: string;
}

/** The Router routing seam: drive each round trip to the receiver Gateway (named by the
 * token prefix) and await its reply. Injected so this coordinator never imports the
 * Router client. */
export interface CrossDomainRouter {
	sendCommit(receiverGatewayId: string, req: XDomainCommitWire): Promise<XDomainCommitReplyWire>;
	sendReveal(receiverGatewayId: string, req: XDomainRevealWire): Promise<XDomainRevealReplyWire>;
}

////////////////////////////////
//  Schemas

/** Boundary validation for an inbound round-1 commit frame (the opaque `payload` the
 * Router relays verbatim). The receiver Gateway parses it before feeding
 * `handleIncomingCommit`, so a malformed pre-trust frame is rejected at the edge. */
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

/** This Gateway's own identity for the handshake: the phone-held owner root key (public)
 * plus this Gateway's keys + ids. The owner SIGNS the link on the phone, so the gateway
 * carries only the public owner key (to compute the SAS and to verify its own signed link). */
export interface CrossDomainSelf {
	ownerSignPub: () => string | null;
	gatewaySignPub: string;
	gatewayBoxPub: string;
	domainId: string;
	gatewayId: string;
}

/** A paired listening session OR a requester-side pending pairing. Keyed by pin in both
 * roles: confirm only needs the FRIEND's keys (to verify the friend's link + store the
 * peer), which is exactly what a pairing holds. */
interface Pairing {
	friendOwnerSignPub: string;
	friendDomainId: string;
	friendGatewayId: string;
	friendGatewaySignPub: string;
	friendGatewayBoxPub: string;
	sas: string;
	expiresAt: number;
}

/** Receiver round-1 state: the commitments exchanged and this side's salt, held between
 * the commit and reveal rounds. The friend's keys are NOT here yet (they arrive at
 * reveal); single-flight is enforced by this object's presence. */
interface ReceiverCommit {
	pin: string;
	requesterCommitment: string;
	receiverSalt: string;
	receiverCommitment: string;
}

/** A receiver-side listening window: the minted token, its expiry, the attempt counter,
 * the in-progress commit (set by round 1), and the final pairing (set by round 2). */
interface ListeningSession {
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
	/** Listening-window TTL (default 600s, matching the enrollment nonce window). */
	ttlMs?: number;
	/** Hard cap on pairing attempts per listening token before it is invalidated. */
	maxAttempts?: number;
	now?: () => number;
}

////////////////////////////////
//  Constants

// The listening window: ~10 minutes, matching the enrollment nonce TTL. The owner is
// on the pairing screen the whole time; leaving cancels it.
const DEFAULT_TTL_MS = 600_000;

// Tight single-digit cap on pairing attempts against one listening token (plan: "tight
// single-digit, global per requester-owner within the window"). On cap-exceeded the token
// + any pairing are invalidated, forcing a full restart (a fresh listen).
const DEFAULT_MAX_ATTEMPTS = 5;

// The random tail of a listening token: 18 bytes base64url, matching the enrollment nonce.
const TOKEN_RANDOM_BYTES = 18;

// The per-side commitment salt: 18 random bytes base64url, hiding the (public) committed
// keys so the commitment is binding without being guessable.
const SALT_RANDOM_BYTES = 18;

////////////////////////////////
//  Functions & Helpers

/** Parse a listening token `<gatewayId>.<random>` into its receiver Gateway id. The
 * gateway-id prefix lets the requester route the request without a separate lookup.
 * Returns null when the token has no separator. */
export function parseListeningToken(token: string): { gatewayId: string } | null {
	const i = token.indexOf(".");
	if (i <= 0) return null;
	return { gatewayId: token.slice(0, i) };
}

////////////////////////////////
//  Class

export class CrossDomainHandshakeCoordinator {
	private readonly self: CrossDomainSelf;
	private readonly peers: CrossDomainPeers;
	private readonly route?: CrossDomainRouter;
	private readonly ttlMs: number;
	private readonly maxAttempts: number;
	private readonly now: () => number;

	// Receiver role: the open listening windows, keyed by token.
	private readonly listening = new Map<string, ListeningSession>();
	// Receiver role: token by pin, so a paired reveal / confirm resolves its session.
	private readonly tokenByPin = new Map<string, string>();
	// Requester role: pending pairings awaiting the human's confirm, keyed by pin.
	private readonly requesterPairings = new Map<string, Pairing>();

	public constructor(deps: CrossDomainHandshakeDeps) {
		this.self = deps.self;
		this.peers = deps.peers;
		this.route = deps.route;
		this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
		this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.now = deps.now ?? Date.now;
	}

	/** RECEIVER: open a listening window. Mints a single-use token `<gatewayId>.<random>`
	 * (the prefix names this Gateway for the requester's routing) and returns this
	 * Gateway's own owner + gateway keys for the SAS. The owner reads the token to the
	 * other owner out of band. Requires the Domain owner key to be present. */
	public listen(): CrossDomainListenResult {
		this.sweep();
		const ownerSignPub = this.self.ownerSignPub();
		if (!ownerSignPub) {
			throw new Error("this Gateway has no Domain owner yet; cannot open a cross-Domain listening window");
		}
		const token = `${this.self.gatewayId}.${randomBytes(TOKEN_RANDOM_BYTES).toString("base64url")}`;
		const expiresAt = this.now() + this.ttlMs;
		this.listening.set(token, { token, expiresAt, attempts: 0 });
		return {
			listeningToken: token,
			receiverOwnerSignPub: ownerSignPub,
			receiverGatewaySignPub: this.self.gatewaySignPub,
			receiverGatewayBoxPub: this.self.gatewayBoxPub,
			receiverDomainId: this.self.domainId,
			receiverGatewayId: this.self.gatewayId,
			expiresAt,
		};
	}

	/** RECEIVER round 1: an inbound commit relayed from the requester's Gateway. Accepts
	 * it ONLY while the named token's window is open; counts the attempt and invalidates
	 * the token on cap-exceeded; rejects a second commit once one is in flight
	 * (single-flight). On success it mints this side's salt + commitment (having seen ONLY
	 * the requester's commitment) and returns this side's commitment - no keys yet. */
	public handleIncomingCommit(req: XDomainCommitWire): XDomainCommitReplyWire {
		this.sweep();
		const ownerSignPub = this.self.ownerSignPub();
		if (!ownerSignPub) throw new Error("this Gateway has no Domain owner yet");
		const session = this.listening.get(req.listeningToken);
		if (!session) throw new Error("no open listening window for this token");

		// Count the attempt FIRST so a brute force against the pin still trips the cap, then
		// invalidate on cap-exceeded (the token + state die; the owner must re-listen).
		session.attempts += 1;
		if (session.attempts > this.maxAttempts) {
			this.invalidate(req.listeningToken);
			throw new Error("too many pairing attempts; the listening window was closed");
		}

		// Single-flight: once a commit is in flight, reject another (a pairing in progress
		// must not be displaced by a racing commit).
		if (session.commit) throw new Error("this listening window is already pairing");

		const receiverSalt = randomBytes(SALT_RANDOM_BYTES).toString("base64url");
		const receiverCommitment = crossDomainCommitment(this.selfParty(ownerSignPub), receiverSalt);
		session.commit = {
			pin: req.pin,
			requesterCommitment: req.requesterCommitment,
			receiverSalt,
			receiverCommitment,
		};
		this.tokenByPin.set(req.pin, req.listeningToken);

		return { receiverCommitment };
	}

	/** RECEIVER round 2: the requester reveals its keys + salt. Verifies the reveal
	 * reproduces the round-1 commitment (abort on mismatch), computes the SAS over both
	 * committed parties + the pin, records the pairing, and returns this side's revealed
	 * keys + salt + the SAS. The pairing now holds the friend's keys for `confirm`. */
	public handleIncomingReveal(req: XDomainRevealWire): XDomainRevealReplyWire {
		this.sweep();
		const ownerSignPub = this.self.ownerSignPub();
		if (!ownerSignPub) throw new Error("this Gateway has no Domain owner yet");
		const session = this.listening.get(req.listeningToken);
		if (!session) throw new Error("no open listening window for this token");
		const commit = session.commit;
		if (!commit || commit.pin !== req.pin) throw new Error("no matching commitment for this reveal");
		if (session.pairing) throw new Error("this pairing already revealed");

		// The requester's revealed keys+ids+salt MUST reproduce the commitment it sent in
		// round 1: a substituted key cannot match the earlier hash, so the grind is closed.
		if (!verifyCrossDomainCommitment(commit.requesterCommitment, req.requesterParty, req.requesterSalt)) {
			throw new Error("requester reveal does not match its commitment");
		}

		const receiverParty = this.selfParty(ownerSignPub);
		const sas = crossDomainSas(receiverParty, req.requesterParty, req.pin);
		session.pairing = {
			friendOwnerSignPub: req.requesterParty.ownerSignPub,
			friendDomainId: req.requesterParty.domainId,
			friendGatewayId: req.requesterParty.gatewayId,
			friendGatewaySignPub: req.requesterParty.gatewaySignPub,
			friendGatewayBoxPub: req.requesterParty.gatewayBoxPub,
			sas,
			expiresAt: session.expiresAt,
		};

		return { receiverParty, receiverSalt: commit.receiverSalt, sas };
	}

	/** REQUESTER: pair against the OTHER side's listening token. Drives both round trips
	 * (commit then reveal) to the receiver Gateway through the Router seam, verifies the
	 * receiver's reveal against its commitment, recomputes the SAS as a cross-check, records
	 * the receiver's keys as a pending pairing keyed by the pin, and returns the SAS for the
	 * phone to display. The phone minted the pin; the gateway holds the keys + salts. */
	public async request(args: {
		listeningToken: string;
		pin: string;
		requesterOwnerSignPub: string;
		requesterDomainId: string;
		requesterGatewayId: string;
	}): Promise<CrossDomainRequestResult> {
		this.sweep();
		if (!this.route) throw new Error("cross-Domain routing is not available on this Gateway");
		const parsed = parseListeningToken(args.listeningToken);
		if (!parsed) throw new Error("malformed listening token");
		// Never pair with our own Gateway (a token cannot name us).
		if (parsed.gatewayId === this.self.gatewayId) {
			throw new Error("a listening token must name a different Gateway");
		}

		const requesterParty: CrossDomainParty = {
			ownerSignPub: args.requesterOwnerSignPub,
			gatewaySignPub: this.self.gatewaySignPub,
			gatewayBoxPub: this.self.gatewayBoxPub,
			domainId: args.requesterDomainId,
			gatewayId: args.requesterGatewayId,
		};
		const requesterSalt = randomBytes(SALT_RANDOM_BYTES).toString("base64url");
		const requesterCommitment = crossDomainCommitment(requesterParty, requesterSalt);

		// Round 1: send our commitment, receive theirs (formed seeing only ours).
		const commitReply = await this.route.sendCommit(parsed.gatewayId, {
			listeningToken: args.listeningToken,
			pin: args.pin,
			requesterCommitment,
		});

		// Round 2: reveal our keys + salt, receive theirs + the SAS.
		const revealReply = await this.route.sendReveal(parsed.gatewayId, {
			listeningToken: args.listeningToken,
			pin: args.pin,
			requesterParty,
			requesterSalt,
		});

		// The receiver's revealed keys MUST reproduce the commitment it sent in round 1: a
		// Router that substituted the receiver's keys after committing cannot match Hb.
		if (
			!verifyCrossDomainCommitment(
				commitReply.receiverCommitment,
				revealReply.receiverParty,
				revealReply.receiverSalt,
			)
		) {
			throw new Error("receiver reveal does not match its commitment; a key was substituted in transit");
		}

		// Recompute the SAS locally over both committed parties + the pin; it must match what
		// the receiver sent, else a key was substituted (refuse rather than display a forged code).
		const sas = crossDomainSas(requesterParty, revealReply.receiverParty, args.pin);
		if (sas !== revealReply.sas) throw new Error("safety code mismatch; a key was substituted in transit");

		const receiver = revealReply.receiverParty;
		this.requesterPairings.set(args.pin, {
			friendOwnerSignPub: receiver.ownerSignPub,
			friendDomainId: receiver.domainId,
			friendGatewayId: receiver.gatewayId,
			friendGatewaySignPub: receiver.gatewaySignPub,
			friendGatewayBoxPub: receiver.gatewayBoxPub,
			sas,
			expiresAt: this.now() + this.ttlMs,
		});

		return {
			sas,
			requesterOwnerSignPub: args.requesterOwnerSignPub,
			receiverOwnerSignPub: receiver.ownerSignPub,
			receiverDomainId: receiver.domainId,
			receiverGatewayId: receiver.gatewayId,
			receiverGatewaySignPub: receiver.gatewaySignPub,
			receiverGatewayBoxPub: receiver.gatewayBoxPub,
		};
	}

	/** EITHER ROLE: the human matched the SAS on the phone, which then owner-signed THIS
	 * side's link and submitted it. Each owner confirms independently: look the pairing up
	 * by pin, verify the owner-signed link under THIS Domain's owner key (and that it binds
	 * the FRIEND's keys from the SAS-verified pairing), then write the friend as a
	 * cross-Domain peer with this owner's own attestation as the stored link. No friend-link
	 * exchange is needed: the seal uses only the friend's box key from the pairing, so the
	 * stored link is an audit artifact and the local owner's signature on it is the
	 * locally-verifiable authority. The pairing is consumed once, so a retried confirm at THIS
	 * layer errors ("no pending pairing"); the console's opId cache replays the original
	 * success reply for an honest retry. The peer store itself is idempotent on
	 * `(domain, gateway)` (a re-link replaces). */
	public confirm(args: { pin: string; mySignedLink: SignedXDomainLink }): CrossDomainConfirmResult {
		this.sweep();
		const ownerSignPub = this.self.ownerSignPub();
		if (!ownerSignPub) throw new Error("this Gateway has no Domain owner yet");

		const pairing = this.takePairing(args.pin);
		if (!pairing) throw new Error("no pending pairing for this pin");

		// This owner's link side must be signed by our owner and bind the FRIEND's keys the SAS
		// confirmed out of band, so the gateway (which never minted the link) checks the phone
		// signed the exact channel it intended. The bound friend keys become the stored peer.
		const mine = args.mySignedLink;
		if (!verifyXDomainLink(mine, ownerSignPub)) {
			throw new Error("own link signature did not verify under this Domain's owner key");
		}
		if (
			mine.link.peerOwnerSignPub !== pairing.friendOwnerSignPub ||
			mine.link.peerDomainId !== pairing.friendDomainId ||
			mine.link.peerGatewayId !== pairing.friendGatewayId ||
			mine.link.peerSignPub !== pairing.friendGatewaySignPub ||
			mine.link.peerBoxPub !== pairing.friendGatewayBoxPub
		) {
			throw new Error("own link does not bind the friend's keys");
		}

		const peer: CrossDomainPeer = {
			friendOwnerSignPub: pairing.friendOwnerSignPub,
			friendDomainId: pairing.friendDomainId,
			friendGatewayId: pairing.friendGatewayId,
			friendSignPub: pairing.friendGatewaySignPub,
			friendBoxPub: pairing.friendGatewayBoxPub,
			link: mine,
		};
		if (!this.peers.add(peer)) throw new Error("failed to store the cross-Domain peer");

		return { ok: true };
	}

	/** RECEIVER: read a listening window's pairing state so the receiver phone learns a
	 * pairing arrived. Before round 2 lands the pairing this returns pairingArrived=false
	 * (with the window's expiry); once the requester's reveal records `session.pairing` it
	 * returns the SAS the receiver computed plus the friend's keys the phone must owner-sign
	 * a link over. Read-only: it does NOT consume or advance the window (confirm consumes it),
	 * so the receiver can poll repeatedly. An unknown / swept token returns expired=true. */
	public listenState(listeningToken: string): CrossDomainListenStateResult {
		this.sweep();
		const session = this.listening.get(listeningToken);
		if (!session) return { pairingArrived: false, expired: true };
		const pairing = session.pairing;
		if (!pairing) return { pairingArrived: false, expiresAt: session.expiresAt };
		return {
			pairingArrived: true,
			// The requester minted the pin; the receiver needs it to confirm its pairing, and a
			// pairing always has the round-1 commit (which carries the pin) on its session.
			pin: session.commit?.pin,
			sas: pairing.sas,
			friendOwnerSignPub: pairing.friendOwnerSignPub,
			friendGatewaySignPub: pairing.friendGatewaySignPub,
			friendGatewayBoxPub: pairing.friendGatewayBoxPub,
			friendDomainId: pairing.friendDomainId,
			friendGatewayId: pairing.friendGatewayId,
			expiresAt: session.expiresAt,
		};
	}

	/** EITHER ROLE: cancel the listening window and/or a pending pairing for this token /
	 * pin (the owner left the pairing screen). Invalidates so a stale frame cannot
	 * complete. Returns whether anything was cancelled. */
	public cancel(args: { listeningToken?: string; pin?: string }): boolean {
		let cancelled = false;
		if (args.listeningToken && this.listening.has(args.listeningToken)) {
			this.invalidate(args.listeningToken);
			cancelled = true;
		}
		if (args.pin) {
			if (this.tokenByPin.has(args.pin)) {
				this.invalidate(this.tokenByPin.get(args.pin) ?? "");
				cancelled = true;
			}
			if (this.requesterPairings.delete(args.pin)) cancelled = true;
		}
		return cancelled;
	}

	/** Invalidate a listening token entirely: drop the session and any pin index pointing
	 * at it. The owner must re-`listen` for a new token. */
	public invalidate(token: string): void {
		const session = this.listening.get(token);
		if (session) {
			for (const [pin, t] of this.tokenByPin) if (t === token) this.tokenByPin.delete(pin);
		}
		this.listening.delete(token);
	}

	/** Test/observability: the count of open listening windows + pending requester pairings. */
	public get openCount(): number {
		return this.listening.size + this.requesterPairings.size;
	}

	////////////////////////////////
	//  Internals

	/** This Gateway's own party (keys + ids) for the commitment + SAS. */
	private selfParty(ownerSignPub: string): CrossDomainParty {
		return {
			ownerSignPub,
			gatewaySignPub: this.self.gatewaySignPub,
			gatewayBoxPub: this.self.gatewayBoxPub,
			domainId: this.self.domainId,
			gatewayId: this.self.gatewayId,
		};
	}

	/** Resolve + remove the pairing for a pin in either role (receiver session pairing or
	 * requester pending pairing), so confirm consumes it once. */
	private takePairing(pin: string): Pairing | null {
		const requester = this.requesterPairings.get(pin);
		if (requester) {
			this.requesterPairings.delete(pin);
			return requester;
		}
		const token = this.tokenByPin.get(pin);
		if (token) {
			const session = this.listening.get(token);
			const pairing = session?.pairing ?? null;
			// Consume the receiver-side window (single confirm closes it).
			this.invalidate(token);
			return pairing;
		}
		return null;
	}

	/** Drop expired listening windows + requester pairings. Lazy, run on every entry point. */
	private sweep(): void {
		const t = this.now();
		for (const [token, session] of this.listening) if (session.expiresAt <= t) this.invalidate(token);
		for (const [pin, pairing] of this.requesterPairings)
			if (pairing.expiresAt <= t) this.requesterPairings.delete(pin);
	}
}

////////////////////////////////
//  Router wiring (requester seam + receiver pump)
//
//  Bridges the coordinator to the evie client. The requester leg drives each round trip
//  as a tool call; the receiver leg validates an inbound relayed frame, runs it through
//  the coordinator, and replies as the matching reply tool call. Mirrors the gateway-relay
//  wiring in hostRelay.ts (one parse, one error surface).

/** The inbound round-1 commit frame the Router routed to this Gateway (the receiver leg).
 * The outer envelope is validated here; the inner `payload` is parsed with
 * XDomainCommitWireSchema before dispatch. */
const InboundCommitFrameSchema = z.object({
	type: z.literal("cross_domain_handshake"),
	handshakeId: z.string().min(1).max(128),
	srcDomain: z.string().min(1).max(64),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	payload: z.unknown(),
});

/** The inbound round-2 reveal frame. */
const InboundRevealFrameSchema = z.object({
	type: z.literal("cross_domain_handshake_reveal"),
	handshakeId: z.string().min(1).max(128),
	srcDomain: z.string().min(1).max(64),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	payload: z.unknown(),
});

export interface CrossDomainHandshakePumpDeps {
	/** Runs an inbound round-1 commit through the coordinator's receiver leg. */
	handleIncomingCommit: (req: XDomainCommitWire) => XDomainCommitReplyWire;
	/** Runs an inbound round-2 reveal through the coordinator's receiver leg. */
	handleIncomingReveal: (req: XDomainRevealWire) => XDomainRevealReplyWire;
	/** Sends a cross_domain_handshake_reply tool call back to the Router (round 1,
	 * correlated by handshakeId). */
	sendCommitReply: (reply: CrossDomainHandshakeReplyParams) => Promise<{ error?: string }>;
	/** Sends a cross_domain_handshake_reveal_reply tool call back to the Router (round 2). */
	sendRevealReply: (reply: CrossDomainHandshakeRevealReplyParams) => Promise<{ error?: string }>;
}

/** Validates an inbound cross_domain_handshake / cross_domain_handshake_reveal frame, runs
 * it through the receiver coordinator, and ships the reply back to the Router. A malformed
 * frame with no handshakeId is dropped (nothing to correlate); any other failure replies
 * with an error so the requester's held call settles fast. Returns a single pump that
 * dispatches on the frame `type`. */
export function createCrossDomainHandshakePump({
	handleIncomingCommit,
	handleIncomingReveal,
	sendCommitReply,
	sendRevealReply,
}: CrossDomainHandshakePumpDeps) {
	return function pump(raw: unknown): void {
		void (async () => {
			const type = (raw as { type?: unknown } | null)?.type;
			if (type === "cross_domain_handshake_reveal") {
				await dispatchReveal(raw);
			} else {
				await dispatchCommit(raw);
			}
		})().catch((err: Error) => {
			console.error(`[cross-domain-handshake] pump error: ${err.message}`);
		});
	};

	async function dispatchCommit(raw: unknown): Promise<void> {
		const parsed = InboundCommitFrameSchema.safeParse(raw);
		if (!parsed.success) {
			const handshakeId = (raw as { handshakeId?: unknown } | null)?.handshakeId;
			if (typeof handshakeId === "string" && handshakeId.length > 0) {
				await sendCommitReply({
					handshakeId,
					ok: false,
					error: `invalid cross_domain_handshake: ${parsed.error.issues[0]?.message ?? "malformed"}`,
				});
			} else {
				console.error(`[cross-domain-handshake] dropping malformed commit frame with no handshakeId`);
			}
			return;
		}
		const frame = parsed.data;
		const req = XDomainCommitWireSchema.safeParse(frame.payload);
		if (!req.success) {
			await sendCommitReply({
				handshakeId: frame.handshakeId,
				ok: false,
				error: `invalid handshake payload: ${req.error.issues[0]?.message ?? "malformed"}`,
			});
			return;
		}
		try {
			const result = handleIncomingCommit(req.data);
			await sendCommitReply({ handshakeId: frame.handshakeId, ok: true, result });
		} catch (err) {
			await sendCommitReply({ handshakeId: frame.handshakeId, ok: false, error: (err as Error).message });
		}
	}

	async function dispatchReveal(raw: unknown): Promise<void> {
		const parsed = InboundRevealFrameSchema.safeParse(raw);
		if (!parsed.success) {
			const handshakeId = (raw as { handshakeId?: unknown } | null)?.handshakeId;
			if (typeof handshakeId === "string" && handshakeId.length > 0) {
				await sendRevealReply({
					handshakeId,
					ok: false,
					error: `invalid cross_domain_handshake_reveal: ${parsed.error.issues[0]?.message ?? "malformed"}`,
				});
			} else {
				console.error(`[cross-domain-handshake] dropping malformed reveal frame with no handshakeId`);
			}
			return;
		}
		const frame = parsed.data;
		const req = XDomainRevealWireSchema.safeParse(frame.payload);
		if (!req.success) {
			await sendRevealReply({
				handshakeId: frame.handshakeId,
				ok: false,
				error: `invalid reveal payload: ${req.error.issues[0]?.message ?? "malformed"}`,
			});
			return;
		}
		try {
			const result = handleIncomingReveal(req.data);
			await sendRevealReply({ handshakeId: frame.handshakeId, ok: true, result });
		} catch (err) {
			await sendRevealReply({ handshakeId: frame.handshakeId, ok: false, error: (err as Error).message });
		}
	}
}
