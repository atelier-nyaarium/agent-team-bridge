import { type DomainSnapshot, REGISTER_MAX_SKEW_MS } from "../../shared/admission.js";
import {
	FEDERATION_PROTOCOL_FLOOR,
	FEDERATION_PROTOCOL_VERSION,
	GatewayRegisterParamsSchema,
} from "../../shared/router-protocol.js";
import { parseInboxAddress } from "../../shared/schemasInbox.js";
import { OP_LEDGER_PROTOCOL } from "../../shared/schemasRegister.js";
import { type DomainMeta, sanitizeDomainId } from "../enrollmentCoordinator.js";
import type { ConnGatewayRecord, GatewayBridgeParams, GatewayRegistration } from "../gatewayBridge.js";
import type { ConnectionId } from "../gatewayTransport.js";
import type { InboxService } from "../inbox/inboxService.js";
import { verifyRegistrationClaim } from "../registrationVerification.js";

export interface RegistrationDeps {
	getDomain: (domainId: string) => DomainSnapshot | null;
	getDomainMeta: (domainId: string) => DomainMeta | null;
	adminDomainId: () => string | null;
	reach?: GatewayBridgeParams["reach"];
	inbox: InboxService | null;
	now: () => number;
	migrationLease: (domainId: string, gatewayId: string) => void;
	migrationFenced: (domainId: string, gatewayId: string) => boolean;
	setConnection: (domainId: string, gatewayId: string, connId: ConnectionId) => void;
	gatewaysInDomain: (domainId: string) => string[];
	setRegistration: (connId: ConnectionId, reg: ConnGatewayRecord) => void;
	notifyRegistered: (registered: GatewayRegistration) => void;
	getConnectionId: (domainId: string, gatewayId: string) => ConnectionId | undefined;
	getIncarnation: (connId: ConnectionId) => number | null | undefined;
	send: (domainId: string, gatewayId: string, frame: Record<string, unknown>) => boolean;
}

/** Gateway identity bootstrap: trust, incarnation, and held-row redelivery. */
export class RegistrationHandler {
	private readonly seenRegisterNonces = new Map<string, number>();

	constructor(private readonly deps: RegistrationDeps) {}

	handle(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = GatewayRegisterParamsSchema.safeParse(params);
		if (!parsed.success)
			return { ok: false, error: `invalid gateway_register: ${parsed.error.issues[0]?.message}` };
		const { gatewayId, protocolVersion } = parsed.data;
		const domainId = sanitizeDomainId(parsed.data.domainId);
		if (protocolVersion < FEDERATION_PROTOCOL_FLOOR) {
			return { ok: false, error: "version_too_old", floor: FEDERATION_PROTOCOL_FLOOR };
		}
		const meta = this.deps.getDomainMeta(domainId);
		if (meta?.status === "pending") {
			console.warn(`[BridgeServer] rejected gateway_register into pending domain "${domainId}/${gatewayId}"`);
			return {
				ok: false,
				pending: true,
				error: `registration_denied: admitted-identity proof required for domain "${domainId}"`,
			};
		}
		const domain = this.deps.getDomain(domainId);
		if (domain) {
			const presented = !!(parsed.data.signPub || parsed.data.admission || parsed.data.proof);
			if (presented) {
				const denied = verifyRegistrationClaim(
					parsed.data,
					{ ownerSignPub: domain.ownerSignPub, revocations: domain.revocations },
					this.deps.now(),
				);
				if (denied) {
					console.warn(`[BridgeServer] rejected registration for "${domainId}/${gatewayId}": ${denied}`);
					return { ok: false, error: `registration_denied: ${denied}` };
				}
				if (!this.rememberRegisterNonce(parsed.data.proofNonce)) {
					console.warn(`[BridgeServer] rejected replayed registration proof for "${domainId}/${gatewayId}"`);
					return { ok: false, error: `registration_denied: registration proof replayed` };
				}
			} else if (domainId !== this.deps.adminDomainId()) {
				// Do not disclose unadmitted Domain state.
				console.warn(
					`[BridgeServer] rejected identity-less registration into a rooted non-admin domain "${domainId}/${gatewayId}"`,
				);
				return {
					ok: false,
					error: `registration_denied: admitted-identity proof required for domain "${domainId}"`,
				};
			}
		}
		this.deps.setConnection(domainId, gatewayId, connId);
		this.deps.migrationLease(domainId, gatewayId);
		// Only admitted identities receive inbox incarnations.
		const admitted = !!parsed.data.signPub;
		const incarnation = !admitted
			? null
			: this.deps.inbox
				? this.deps.inbox.registerGateway(domainId, gatewayId)
				: 1;
		if (admitted && incarnation === null)
			console.warn(`[BridgeServer] inbox unavailable for ${domainId}/${gatewayId}; registered without it`);
		this.deps.setRegistration(connId, {
			domainId,
			gatewayId,
			signPub: parsed.data.signPub ?? null,
			incarnation,
			protocolVersion,
		});
		console.log(`[BridgeServer] Gateway registered: ${domainId}/${gatewayId} (v${protocolVersion})`);
		const peers = this.deps.gatewaysInDomain(domainId).filter((h) => h !== gatewayId);
		const reply: Record<string, unknown> = {
			ok: true,
			protocolFloor: FEDERATION_PROTOCOL_FLOOR,
			protocolVersion: FEDERATION_PROTOCOL_VERSION,
			opLedgerProtocol: OP_LEDGER_PROTOCOL,
			domainId,
			gateways: peers,
			...(incarnation !== null ? { incarnation } : {}),
		};
		if (domain) reply.domain = domain;
		if (this.deps.migrationFenced(domainId, gatewayId)) reply.migrationFenced = true;
		if (meta) {
			reply.domainStatus = meta.status;
			if (meta.displayName != null) reply.displayName = meta.displayName;
		}
		reply.isAdminDomain = domainId === this.deps.adminDomainId();
		// Preserve cached reach when available.
		const reach = this.deps.reach?.();
		if (reach && (reach.publicHost || reach.lanAddresses?.length)) reply.reach = reach;
		if (incarnation !== null) {
			this.redeliverPending(domainId, gatewayId, incarnation);
			const registered = { domainId, gatewayId, signPub: parsed.data.signPub as string, incarnation };
			this.deps.notifyRegistered(registered);
		}
		return reply;
	}

	private rememberRegisterNonce(nonce: string | undefined): boolean {
		if (!nonce) return false;
		const now = this.deps.now();
		for (const [key, expiry] of this.seenRegisterNonces) if (expiry <= now) this.seenRegisterNonces.delete(key);
		if (this.seenRegisterNonces.has(nonce)) return false;
		this.seenRegisterNonces.set(nonce, now + REGISTER_MAX_SKEW_MS);
		return true;
	}

	/** Redeliver held rows under current incarnation. */
	private redeliverPending(domainId: string, gatewayId: string, incarnation: number): void {
		const inbox = this.deps.inbox;
		if (!inbox) return;
		setTimeout(() => {
			const connId = this.deps.getConnectionId(domainId, gatewayId);
			if (!connId || this.deps.getIncarnation(connId) !== incarnation) return;
			let pending: ReturnType<InboxService["pendingFor"]>;
			try {
				pending = inbox.pendingFor(domainId, gatewayId);
			} catch (err) {
				console.warn(
					`[BridgeServer] re-delivery skipped for ${domainId}/${gatewayId}: ${(err as Error).message}`,
				);
				return;
			}
			for (const entry of pending) {
				const address = parseInboxAddress(entry.address);
				if (!address) continue;
				this.deps.send(domainId, gatewayId, {
					type: "inbox_deliver",
					address: entry.address,
					rows: entry.rows,
					incarnation,
					deliveryEpoch: inbox.deliveryEpoch(address),
				});
			}
		}, 0);
	}
}
