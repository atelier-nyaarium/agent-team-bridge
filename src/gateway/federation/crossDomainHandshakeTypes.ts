import type { Ambient } from "../../shared/ambient.js";
import type {
	XDomainCommitReplyWire,
	XDomainCommitWire,
	XDomainRevealReplyWire,
	XDomainRevealWire,
} from "./crossDomainHandshakeWire.js";
import type { CrossDomainPeers } from "./crossDomainPeers.js";

export interface CrossDomainRouter {
	sendCommit(receiverGatewayId: string, req: XDomainCommitWire): Promise<XDomainCommitReplyWire>;
	sendReveal(receiverGatewayId: string, req: XDomainRevealWire): Promise<XDomainRevealReplyWire>;
}

export interface CrossDomainSelf {
	ownerSignPub: () => string | null;
	gatewaySignPub: string;
	gatewayBoxPub: string;
	domainId: string;
	gatewayId: string;
}

export interface Pairing {
	friendOwnerSignPub: string;
	friendDomainId: string;
	friendGatewayId: string;
	friendGatewaySignPub: string;
	friendGatewayBoxPub: string;
	sas: string;
	expiresAt: number;
}

export interface ReceiverCommit {
	pin: string;
	requesterCommitment: string;
	receiverSalt: string;
	receiverCommitment: string;
}

export interface ListeningSession {
	token: string;
	expiresAt: number;
	attempts: number;
	commit?: ReceiverCommit;
	pairing?: Pairing;
}

export interface CrossDomainHandshakeDeps {
	self: CrossDomainSelf;
	peers: CrossDomainPeers;
	route?: CrossDomainRouter;
	ttlMs?: number;
	maxAttempts?: number;
	ambient: Pick<Ambient, "now" | "randomBytes">;
}

export const DEFAULT_TTL_MS = 3_600_000;

// Caps SAS guesses per listening window.
export const DEFAULT_MAX_ATTEMPTS = 5;
