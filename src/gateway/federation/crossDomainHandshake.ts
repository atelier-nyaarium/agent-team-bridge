import type { Ambient } from "../../shared/ambient.js";
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

export class CrossDomainHandshakeCoordinator {
	private readonly self: CrossDomainSelf;
	private readonly peers: CrossDomainPeers;
	private readonly route?: CrossDomainRouter;
	private readonly ttlMs: number;
	private readonly maxAttempts: number;
	private readonly now: () => number;
	private readonly ambient: Pick<Ambient, "now" | "randomBytes">;

	private readonly listening = new Map<string, ListeningSession>();
	private readonly tokenByPin = new Map<string, string>();
	private readonly requesterPairings = new Map<string, Pairing>();

	public constructor(deps: CrossDomainHandshakeDeps) {
		this.self = deps.self;
		this.peers = deps.peers;
		this.route = deps.route;
		this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
		this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.ambient = deps.ambient;
		this.now = () => deps.ambient.now();
	}

	public listen(): CrossDomainListenResult {
		this.sweep();
		const ownerSignPub = this.self.ownerSignPub();
		if (!ownerSignPub) {
			throw new Error("this Gateway has no Domain owner yet; cannot open a cross-Domain listening window");
		}
		const token = `${this.self.gatewayId}.${this.ambient.randomBytes(TOKEN_RANDOM_BYTES).toString("base64url")}`;
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

	public handleIncomingCommit(req: XDomainCommitWire): XDomainCommitReplyWire {
		this.sweep();
		const ownerSignPub = this.self.ownerSignPub();
		if (!ownerSignPub) throw new Error("this Gateway has no Domain owner yet");
		const session = this.listening.get(req.listeningToken);
		if (!session) throw new Error("no open listening window for this token");

		// Count attempts before enforcing the cap.
		session.attempts += 1;
		if (session.attempts > this.maxAttempts) {
			this.invalidate(req.listeningToken);
			throw new Error("too many pairing attempts; the listening window was closed");
		}

		// Reject racing commits while pairing.
		if (session.commit) throw new Error("this listening window is already pairing");

		const receiverSalt = this.ambient.randomBytes(SALT_RANDOM_BYTES).toString("base64url");
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

	public handleIncomingReveal(req: XDomainRevealWire): XDomainRevealReplyWire {
		this.sweep();
		const ownerSignPub = this.self.ownerSignPub();
		if (!ownerSignPub) throw new Error("this Gateway has no Domain owner yet");
		const session = this.listening.get(req.listeningToken);
		if (!session) throw new Error("no open listening window for this token");
		const commit = session.commit;
		if (!commit || commit.pin !== req.pin) throw new Error("no matching commitment for this reveal");
		if (session.pairing) throw new Error("this pairing already revealed");

		// Revealed requester keys must reproduce the commitment.
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
		const requesterSalt = this.ambient.randomBytes(SALT_RANDOM_BYTES).toString("base64url");
		const requesterCommitment = crossDomainCommitment(requesterParty, requesterSalt);

		const commitReply = await this.route.sendCommit(parsed.gatewayId, {
			listeningToken: args.listeningToken,
			pin: args.pin,
			requesterCommitment,
		});

		const revealReply = await this.route.sendReveal(parsed.gatewayId, {
			listeningToken: args.listeningToken,
			pin: args.pin,
			requesterParty,
			requesterSalt,
		});

		// Revealed receiver keys must reproduce the commitment.
		if (
			!verifyCrossDomainCommitment(
				commitReply.receiverCommitment,
				revealReply.receiverParty,
				revealReply.receiverSalt,
			)
		) {
			throw new Error("receiver reveal does not match its commitment; a key was substituted in transit");
		}

		// Recompute SAS before displaying or storing it.
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

	public confirm(args: { pin: string; mySignedLink: SignedXDomainLink }): CrossDomainConfirmResult {
		this.sweep();
		const ownerSignPub = this.self.ownerSignPub();
		if (!ownerSignPub) throw new Error("this Gateway has no Domain owner yet");

		const pairing = this.takePairing(args.pin);
		if (!pairing) throw new Error("no pending pairing for this pin");

		const mine = args.mySignedLink;
		// The owner signs the exact SAS-verified peer keys.
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

	public listenState(listeningToken: string): CrossDomainListenStateResult {
		this.sweep();
		const session = this.listening.get(listeningToken);
		if (!session) return { pairingArrived: false, expired: true };
		const pairing = session.pairing;
		if (!pairing) return { pairingArrived: false, expiresAt: session.expiresAt };
		return {
			pairingArrived: true,
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

	public invalidate(token: string): void {
		const session = this.listening.get(token);
		if (session) {
			for (const [pin, t] of this.tokenByPin) if (t === token) this.tokenByPin.delete(pin);
		}
		this.listening.delete(token);
	}

	public get openCount(): number {
		return this.listening.size + this.requesterPairings.size;
	}

	private selfParty(ownerSignPub: string): CrossDomainParty {
		return {
			ownerSignPub,
			gatewaySignPub: this.self.gatewaySignPub,
			gatewayBoxPub: this.self.gatewayBoxPub,
			domainId: this.self.domainId,
			gatewayId: this.self.gatewayId,
		};
	}

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
			// Confirmation consumes the receiver window.
			this.invalidate(token);
			return pairing;
		}
		return null;
	}

	private sweep(): void {
		const t = this.now();
		for (const [token, session] of this.listening) if (session.expiresAt <= t) this.invalidate(token);
		for (const [pin, pairing] of this.requesterPairings)
			if (pairing.expiresAt <= t) this.requesterPairings.delete(pin);
	}
}
