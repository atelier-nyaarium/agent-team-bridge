import type { DomainSnapshot } from "../shared/admission.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";
import {
	formatInboxAddress,
	type InboxAddress,
	type InboxRow,
	type OpKey,
	parseInboxAddress,
	signRowEnvelope,
} from "../shared/schemasInbox.js";
import type { ReferenceHeldStore } from "./blobs/referenceHeldStore.js";
import { createBoardService } from "./board/boardService.js";
import type { GatewayBridge } from "./gatewayBridge.js";
import type { InboxService } from "./inbox/inboxService.js";
import type { OwnerOpIntake } from "./inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "./inbox/ownerStoreRegistry.js";
import type { OwnerServiceHooks } from "./ownerServiceHooks.js";
import { createPresenceService } from "./presence/presenceService.js";
import { createScheduledService } from "./scheduled/scheduledService.js";
import { createShareService } from "./share/shareService.js";
import { createCapabilitiesService } from "./tier1/capabilitiesService.js";
import { createReadAnchorsService } from "./tier1/readAnchorsService.js";

export interface OwnerServicesDeps {
	registry: OwnerStoreRegistry;
	inbox: InboxService;
	bridge: GatewayBridge;
	intake: OwnerOpIntake;
	referenceHeld: ReferenceHeldStore;
	routerIdentity: { signPub: string; signPriv: string };
	getDomain: (domainId: string) => DomainSnapshot | null;
	hasLinkEdge: (srcDomainId: string, dstDomainId: string) => boolean;
}

// Longer waits are chained because setTimeout has a maximum delay.
const MAX_TIMER_MS = 2_147_483_647;

/** Re-arms delays longer than setTimeout's maximum. */
export function chainedTimer(delayMs: number, fn: () => void): { handle: () => ReturnType<typeof setTimeout> } {
	let current: ReturnType<typeof setTimeout>;
	const arm = (remaining: number) => {
		current = setTimeout(
			() => (remaining > MAX_TIMER_MS ? arm(remaining - MAX_TIMER_MS) : fn()),
			Math.min(remaining, MAX_TIMER_MS),
		);
		current.unref?.();
	};
	arm(delayMs);
	return { handle: () => current };
}

export function createOwnerServices(deps: OwnerServicesDeps) {
	const { registry, inbox, bridge, referenceHeld } = deps;
	const connected = (domainId: string): string[] => bridge.registeredGateways(domainId).map((g) => g.gatewayId);
	const admittedGateways = (domainId: string): string[] => {
		const snapshot = deps.getDomain(domainId);
		if (!snapshot) return [];
		const revoked = new Set(snapshot.revocations.map((r) => r.revocation.signPub));
		return snapshot.admissions
			.filter((a) => a.admission.kind === "gateway" && a.admission.gatewayId && !revoked.has(a.admission.signPub))
			.map((a) => a.admission.gatewayId as string);
	};
	const linkedDomains = (domainId: string): string[] =>
		registry.domains().filter((other) => other !== domainId && deps.hasLinkEdge(domainId, other));
	const hooks: OwnerServiceHooks = {
		ownerOp: (kind, handler) => deps.intake.register(kind, handler),
		gatewayFrame: (name, handler) => bridge.registerGatewayFrame(name, handler),
		onGatewayRegistered: (listener) => bridge.onGatewayRegistered(listener),
		onGatewayDropped: (listener) => bridge.onGatewayDropped(listener),
		onSessionForgotten: (listener) => bridge.onSessionForgotten(listener),
		pushFrameTo: (domainId, gatewayId, frame) => bridge.pushFrameTo(domainId, gatewayId, frame),
		gatewayIncarnation: (domainId, gatewayId) => bridge.gatewayIncarnation(domainId, gatewayId),
		connectedGateways: connected,
	};
	/** Deliver accepted rows or mark them waking. */
	const deliver = (domainId: string, address: InboxAddress, row: InboxRow): void => {
		if (!bridge.pushInboxRows(domainId, formatInboxAddress(address), [row]))
			inbox.markWaking(domainId, row.envelope.opKey);
	};

	const share = createShareService({
		registry,
		isLinked: (domainId, friendDomainId) => deps.hasLinkEdge(domainId, friendDomainId),
		// Link revocation arrives as its own enroll op.
		dropLinkEdge: () => undefined,
		retireRevokedPeerRows: (domainId, sessionTarget, friendDomainId) => {
			inbox.retireRevokedPeerRows(domainId, sessionTarget, friendDomainId);
		},
		connectedGateways: connected,
		now: () => registry.now(),
	});
	// Cross-Domain delivery keeps a share alive.
	const peerGate = (dstDomainId: string, sessionTarget: string, srcDomainId: string): number | null => {
		const generation = share.admitPeerRow(dstDomainId, sessionTarget, srcDomainId);
		if (generation !== null) share.touch(dstDomainId, sessionTarget);
		return generation;
	};
	inbox.setPeerGate(peerGate);
	bridge.setPeerRowGate(peerGate);
	// A row that left its inbox no longer holds its files.
	inbox.onRowRetired((domainId, addressText, row) => {
		const address = parseInboxAddress(addressText);
		if (address?.kind !== "session") return;
		const id = `${address.domainId}/${address.gatewayId}/${address.sessionId}:${row.seq}`;
		for (const blobId of row.envelope.contentRefs) {
			try {
				referenceHeld.release(domainId, blobId, { kind: "row", id });
			} catch (error) {
				console.warn(`[router] row reference release failed for ${blobId}: ${(error as Error).message}`);
			}
		}
	});

	const isShared = (domainId: string, sessionTarget: string, toDomainId: string) =>
		share.isSharedTo(domainId, sessionTarget, toDomainId);
	const presence = createPresenceService({
		registry,
		projection: { admittedGateways, linkedDomains, isShared, connected },
		friend: { isShared },
		touch: (domainId, sessionTarget) => share.touch(domainId, sessionTarget),
	});

	const board = createBoardService({
		registry,
		inbox,
		referenceHeld: {
			has: (domainId, blobId) => referenceHeld.has(domainId, blobId),
			hold: (domainId, blobId, id) => referenceHeld.hold(domainId, blobId, { kind: "entry", id }),
			release: (domainId, blobId, id) => referenceHeld.release(domainId, blobId, { kind: "entry", id }),
		},
		deliver,
	});

	const appendScheduledMessage = (
		domainId: string,
		address: InboxAddress,
		opKey: OpKey,
		body: ContentEnvelope,
		contentRefs: string[],
	) => {
		const envelope = {
			origin: { kind: "router" as const, domainId },
			opKey,
			epoch: body.epoch,
			kind: "message" as const,
			contentRefs,
		};
		const row = { envelope, producerSig: signRowEnvelope(envelope, deps.routerIdentity.signPriv), body };
		const result = inbox.appendRow({ address, row, producerSignPub: deps.routerIdentity.signPub });
		if (result.row) deliver(domainId, address, result.row);
		return result;
	};
	const scheduled = createScheduledService({
		registry,
		inbox,
		appendScheduledMessage,
		referenceHeld: {
			has: (domainId, blobId) => referenceHeld.has(domainId, blobId),
			hold: (domainId, blobId, ref) => referenceHeld.hold(domainId, blobId, ref),
			release: (domainId, blobId, ref) => referenceHeld.release(domainId, blobId, ref),
		},
		scheduler: {
			set: (ms, fn) => chainedTimer(ms, fn),
			clear: (handle) => clearTimeout((handle as ReturnType<typeof chainedTimer>).handle()),
		},
		now: () => registry.now(),
	});

	const capabilities = createCapabilitiesService({ registry });
	const readAnchors = createReadAnchorsService({ registry });

	for (const service of [share, presence, board, scheduled, capabilities, readAnchors]) service.register(hooks);

	const perDomain = (label: string, fn: (domainId: string) => void): void => {
		for (const domainId of registry.domains()) {
			try {
				fn(domainId);
			} catch (error) {
				console.warn(`[router] ${label} skipped ${domainId}: ${(error as Error).message}`);
			}
		}
	};

	return {
		share,
		presence,
		board,
		scheduled,
		capabilities,
		readAnchors,
		reconcileReferences(): void {
			perDomain("reference reconcile", (domainId) => {
				const store = registry.for(domainId);
				referenceHeld.reconcile(domainId, (ref) => {
					if (ref.kind === "entry") return store.get("board.entry", ref.id) !== null;
					if (ref.kind === "scheduled") return store.get("scheduled", ref.id) !== null;
					const split = ref.id.lastIndexOf(":");
					if (split <= 0) return false;
					const address = `session:${ref.id.slice(0, split)}`;
					const seq = Number(ref.id.slice(split + 1));
					return Number.isSafeInteger(seq) && store.rows(address, seq, 1).some((row) => row.seq === seq);
				});
			});
		},
		sweep(now = registry.now()): void {
			perDomain("share sweep", (domainId) => share.sweep(domainId, now));
			perDomain("board sweep", (domainId) => board.sweepTrash(domainId, now));
			perDomain("capability sweep", (domainId) => capabilities.sweep(domainId, now));
		},
		/** Re-arm armed sends during boot. */
		rearm(): void {
			perDomain("presence rearm", (domainId) => presence.rearm(domainId));
			perDomain("scheduled rearm", (domainId) => scheduled.rearm(domainId));
		},
	};
}
