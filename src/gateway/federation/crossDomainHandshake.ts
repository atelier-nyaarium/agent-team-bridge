import { randomBytes } from "node:crypto";
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
import type { SignedXDomainLink } from "../../shared/federation-protocol.js";
import { verifyXDomainLink } from "../../shared/federation-protocol.js";
import {
	type CrossDomainHandshakeDeps,
	type CrossDomainRouter,
	type CrossDomainSelf,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_TTL_MS,
	type ListeningSession,
	type Pairing,
} from "./crossDomainHandshakeTypes.js";
import {
	parseListeningToken,
	SALT_RANDOM_BYTES,
	TOKEN_RANDOM_BYTES,
	type XDomainCommitReplyWire,
	type XDomainCommitWire,
	type XDomainRevealReplyWire,
	type XDomainRevealWire,
} from "./crossDomainHandshakeWire.js";
import type { CrossDomainPeer, CrossDomainPeers } from "./crossDomainPeers.js";

export type { CrossDomainHandshakePumpDeps } from "./crossDomainHandshakePump.js";
export { createCrossDomainHandshakePump } from "./crossDomainHandshakePump.js";
export type { CrossDomainHandshakeDeps, CrossDomainRouter, CrossDomainSelf } from "./crossDomainHandshakeTypes.js";
export type {
	XDomainCommitReplyWire,
	XDomainCommitWire,
	XDomainRevealReplyWire,
	XDomainRevealWire,
} from "./crossDomainHandshakeWire.js";
export {
	parseCommitReply,
	parseListeningToken,
	parseRevealReply,
	XDomainCommitWireSchema,
	XDomainRevealWireSchema,
} from "./crossDomainHandshakeWire.js";

////////////////////////////////
//  Cross-Domain listening-mode handshake
//
//  The both-present pairing that establishes a persistent cross-Domain trust link between two
//  Gateways owned by DIFFERENT owners. This coordinator owns the gateway-side state (listening
//  window, requester-minted pin pairing, attempt cap, commit-reveal SAS exchange) and is the
//  only writer of the disjoint CrossDomainPeers store. It does not route over the Router itself:
//  a Gateway reaches the other through an injected `route` seam, and a receiver Gateway feeds
//  inbound relayed frames in via `handleIncomingCommit` / `handleIncomingReveal`.
//
//  The exchange is COMMIT-REVEAL so the content-blind Router cannot offline-grind the SAS. Each
//  side publishes a hiding commitment to its own keys+ids+salt before either reveals, so the
//  Router must pick any key substitution before it learns the peer's keys. That collapses the
//  attack to a single online 1-in-10^6 guess bounded by the attempt cap. A reveal that does not
//  reproduce the earlier commitment aborts. The SAS is computed over the COMMITTED keys + both
//  sides' ids + the pin.
//
//  Two round trips, both content-blind through the Router:
//   1. commit:  requester -> receiver (Ha) ; receiver -> requester (Hb)
//   2. reveal:  requester -> receiver (A keys+salt) ; receiver -> requester (B keys+salt+SAS)
//
//  Roles:
//  - LISTENER (receiver): opens a window (`listen`), mints a single-use token, accepts ONE
//    pairing bound to it (`handleIncomingCommit` then `handleIncomingReveal`), and on the SAS
//    match writes the friend as a peer (`confirm`). It accepts frames only while its window is
//    open and the token matches.
//  - REQUESTER: pairs against the other side's token (`request`), driving both round trips
//    through the `route` seam, then on the SAS match writes the friend as a peer (`confirm`).
//
//  Both confirms are independent and symmetric: each owner signs one link attesting the OTHER's
//  keys (both sides hold them from the SAS-verified reveal) and each Gateway stores its own
//  owner's attestation. No cross-Gateway link exchange is needed because the seal only uses the
//  friend's box key from the pairing, so whose signature is on the stored link does not affect
//  seal security.

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

	/** RECEIVER: open a listening window. Mints a single-use token `<gatewayId>.<random>` (the
	 * prefix names this Gateway for routing) and returns this Gateway's keys for the SAS. The
	 * owner reads the token to the other owner out of band. Requires the Domain owner key. */
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

	/** RECEIVER round 1: an inbound commit relayed from the requester. Accepted only while the
	 * token's window is open; mints this side's salt + commitment (formed seeing only the
	 * requester's commitment) and returns it. No keys revealed yet. */
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

	/** RECEIVER round 2: the requester reveals its keys + salt. Verifies the reveal reproduces
	 * the round-1 commitment (abort on mismatch), computes the SAS over both committed parties +
	 * the pin, and records the pairing (which then holds the friend's keys for `confirm`). */
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

	/** REQUESTER: pair against the OTHER side's listening token. Drives both round trips through
	 * the Router seam, verifies the receiver's reveal against its commitment, recomputes the SAS as
	 * a cross-check, and records the receiver's keys as a pending pairing keyed by the pin. */
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

	/** EITHER ROLE: the human matched the SAS, and the phone owner-signed THIS side's link and
	 * submitted it. Look the pairing up by pin, verify the link under THIS Domain's owner key and
	 * that it binds the FRIEND's keys from the SAS-verified pairing, then write the friend as a peer
	 * with this owner's attestation as the stored link. No friend-link exchange is needed: the seal
	 * uses only the friend's box key, so the stored link is an audit artifact. The pairing is consumed
	 * once, so a retried confirm here errors; the console's opId cache replays the original reply. */
	public confirm(args: { pin: string; mySignedLink: SignedXDomainLink }): CrossDomainConfirmResult {
		this.sweep();
		const ownerSignPub = this.self.ownerSignPub();
		if (!ownerSignPub) throw new Error("this Gateway has no Domain owner yet");

		const pairing = this.takePairing(args.pin);
		if (!pairing) throw new Error("no pending pairing for this pin");

		// The link must be signed by our owner and bind the FRIEND's keys the SAS confirmed, so the
		// gateway (which never minted it) checks the phone signed the exact channel it intended.
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

	/** RECEIVER: read a listening window's pairing state so the receiver phone learns a pairing
	 * arrived. Returns pairingArrived=false until round 2 records `session.pairing`, then the SAS
	 * plus the friend's keys the phone must owner-sign a link over. Read-only (confirm consumes the
	 * window), so the receiver can poll repeatedly. An unknown / swept token returns expired=true. */
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

	/** EITHER ROLE: cancel the listening window and/or pending pairing for this token / pin (the
	 * owner left the pairing screen), so a stale frame cannot complete. Returns whether anything was. */
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
