import type { DomainSnapshot } from "../shared/admission.js";
import type { BlobReference } from "../shared/blob-reference.js";
import { OwnerBlobFetchParamsSchema } from "../shared/router-protocol.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";
import {
	formatInboxAddress,
	GatewayValueOpSchema,
	type InboxAddress,
	type InboxRow,
	type OpKey,
	PlanesReadValueSchema,
	parseInboxAddress,
	signRowEnvelope,
} from "../shared/schemasInbox.js";
import type { ReferenceHeldStore } from "./blobs/referenceHeldStore.js";
import { createBoardService } from "./board/boardService.js";
import type { ConsoleSockets } from "./console/consoleSockets.js";
import type { GatewayBridge } from "./gatewayBridge.js";
import type { InboxService } from "./inbox/inboxService.js";
import type { OwnerOpIntake } from "./inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "./inbox/ownerStoreRegistry.js";
import { createKeyDeliveryService } from "./keyDeliveryService.js";
import { createCursorService } from "./migration/cursorService.js";
import { createLeaseService, readRouterMigrationWindow } from "./migration/leaseService.js";
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
	linkEdgeId: (srcDomainId: string, dstDomainId: string) => string | null;
	/** Owner rows wait for the next read. */
	consoleSockets?: Pick<ConsoleSockets, "pushOwnerRow" | "pushPlane" | "forget" | "readPlanes">;
	leases?: ReturnType<typeof createLeaseService>;
}

const MAX_TIMER_MS = 2_147_483_647;

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
	deps.intake.setGatewayProtocol((domainId, gatewayId) => bridge.gatewayProtocol(domainId, gatewayId));
	referenceHeld.setReferenceExists((domainId, ref) => {
		const store = registry.for(domainId);
		if (ref.kind === "entry") return store.get("board.entry", ref.entryId) !== null;
		if (ref.kind === "scheduled")
			return (
				store.get("scheduled", `${ref.target.domainId}/${ref.target.gatewayId}/${ref.target.sessionId}`) !==
				null
			);
		return store.rows(formatInboxAddress(ref.address), ref.seq, 1).some((row) => row.seq === ref.seq);
	});
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
	/** Owner rows use durable cursors. */
	const deliver = (domainId: string, address: InboxAddress, row: InboxRow): void => {
		if (address.kind === "owner") {
			deps.consoleSockets?.pushOwnerRow(domainId, null, row);
			return;
		}
		if (!bridge.pushInboxRows(domainId, formatInboxAddress(address), [row]))
			inbox.markWaking(domainId, row.envelope.opKey);
	};

	deps.intake.register("hello", (op) => ({
		opKey: { conversationId: op.conversationId, opId: op.opId },
		outcome: "complete" as const,
		hello: { domainId: op.domainId, signerSignPub: op.signerSignPub },
	}));

	deps.intake.register("blob_fetch", (op, value) =>
		bridge.fetchBlobForOwner(op.domainId, OwnerBlobFetchParamsSchema.parse(value)),
	);
	deps.intake.register("gateway_value", (op, value) => {
		const parsed = GatewayValueOpSchema.parse(value);
		return bridge
			.forwardGatewayValue(op.domainId, {
				opId: op.opId,
				conversationId: op.conversationId,
				signerSignPub: op.signerSignPub,
				device: op.device,
				...parsed,
			})
			.then((result) => {
				const opKey = { conversationId: op.conversationId, opId: op.opId };
				const outcome =
					result && typeof result === "object" && "outcome" in result && typeof result.outcome === "string"
						? result.outcome
						: null;
				if (outcome === "unreachable" || outcome === "timeout" || outcome === "unsupported")
					return { opKey, outcome: "failed" as const, reason: outcome };
				return { opKey, outcome: "accepted" as const, result };
			});
	});
	deps.intake.register("planes_read", (op, value) => {
		const parsed = PlanesReadValueSchema.parse(value);
		return {
			opKey: { conversationId: op.conversationId, opId: op.opId },
			outcome: "accepted" as const,
			result: { planes: deps.consoleSockets?.readPlanes(op.domainId, op.signerSignPub, parsed.known) ?? [] },
		};
	});

	const share = createShareService({
		registry,
		isLinked: (domainId, friendDomainId) => deps.hasLinkEdge(domainId, friendDomainId),
		linkEdgeId: (domainId, friendDomainId) => deps.linkEdgeId(domainId, friendDomainId),
		dropLinkEdge: () => undefined,
		retireRevokedPeerRows: (domainId, sessionTarget, friendDomainId) => {
			inbox.retireRevokedPeerRows(domainId, sessionTarget, friendDomainId);
		},
		retireRevokedPeerRowsInBatch: (store, tx, domainId, sessionTarget, friendDomainId) =>
			inbox.retireRevokedPeerRowsInBatch(store, tx, domainId, sessionTarget, friendDomainId),
		connectedGateways: connected,
		now: () => registry.now(),
	});
	const peerGate = (dstDomainId: string, sessionTarget: string, srcDomainId: string): number | null => {
		const generation = share.admitPeerRow(dstDomainId, sessionTarget, srcDomainId);
		if (generation !== null) share.touch(dstDomainId, sessionTarget);
		return generation;
	};
	inbox.setPeerGate(peerGate);
	bridge.setPeerRowGate(peerGate);
	const leases = deps.leases ?? createLeaseService({ registry, migrationWindow: readRouterMigrationWindow });
	bridge.setMigrationFence((domainId, gatewayId) => leases.fenced(domainId, gatewayId));
	bridge.setMigrationReady((domainId) => leases.ready(domainId));
	bridge.setMigrationLease((domainId, gatewayId) => {
		const window = readRouterMigrationWindow();
		if (window.fenced && window.epoch !== null && leases.read(domainId, gatewayId)?.epoch !== window.epoch)
			leases.put(domainId, gatewayId, "active");
	});
	inbox.onRowRetired((domainId, addressText, row) => {
		const address = parseInboxAddress(addressText);
		if (address?.kind !== "session") return;
		const ref: BlobReference = { kind: "row", address, seq: row.seq };
		try {
			referenceHeld.applyRefs(domainId, [{ ref, blobIds: [] }]);
		} catch (error) {
			console.warn(`[router] row reference release failed: ${(error as Error).message}`);
		}
	});

	const isShared = (domainId: string, sessionTarget: string, toDomainId: string) =>
		share.isSharedTo(domainId, sessionTarget, toDomainId);
	const presence = createPresenceService({
		registry,
		projection: { admittedGateways, linkedDomains, isShared, connected },
		friend: { isShared },
		touch: (domainId, sessionTarget) => share.touch(domainId, sessionTarget),
		pokeOwner: (domainId, version, projection) =>
			deps.consoleSockets?.pushPlane(domainId, "presence", version, projection),
	});

	const board = createBoardService({
		registry,
		inbox,
		referenceHeld: {
			has: (domainId, blobId) => referenceHeld.has(domainId, blobId),
			applyRefs: (domainId, sets) => referenceHeld.applyRefs(domainId, sets),
		},
		deliver,
		pokeOwner: (domainId, revision) => deps.consoleSockets?.pushPlane(domainId, "taskBoard", revision, undefined),
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
	const keyDelivery = createKeyDeliveryService({
		registry,
		inbox,
		intake: deps.intake,
		routerIdentity: deps.routerIdentity,
		getDomain: deps.getDomain,
		deliver,
	});
	const scheduled = createScheduledService({
		registry,
		inbox,
		appendScheduledMessage,
		referenceHeld: {
			has: (domainId, blobId) => referenceHeld.has(domainId, blobId),
			applyRefs: (domainId, sets) => referenceHeld.applyRefs(domainId, sets),
		},
		scheduler: {
			set: (ms, fn) => chainedTimer(ms, fn),
			clear: (handle) => clearTimeout((handle as ReturnType<typeof chainedTimer>).handle()),
		},
		now: () => registry.now(),
	});

	const capabilities = createCapabilitiesService({ registry });
	const readAnchors = createReadAnchorsService({ registry });

	const cursors = createCursorService({ registry, migrationEpoch: () => readRouterMigrationWindow().epoch ?? 0 });
	for (const service of [share, presence, board, scheduled, capabilities, readAnchors, cursors, keyDelivery])
		service.register(hooks);

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
					if (ref.kind === "entry") return store.get("board.entry", ref.entryId) !== null;
					if (ref.kind === "scheduled")
						return (
							store.get(
								"scheduled",
								`${ref.target.domainId}/${ref.target.gatewayId}/${ref.target.sessionId}`,
							) !== null
						);
					return store.rows(formatInboxAddress(ref.address), ref.seq, 1).some((row) => row.seq === ref.seq);
				});
			});
		},
		sweep(now = registry.now()): void {
			perDomain("share sweep", (domainId) => share.sweep(domainId, now));
			perDomain("board sweep", (domainId) => board.sweepTrash(domainId, now));
			perDomain("capability sweep", (domainId) => capabilities.sweep(domainId, now));
		},
		rearm(): void {
			perDomain("presence rearm", (domainId) => presence.rearm(domainId));
			perDomain("scheduled rearm", (domainId) => scheduled.rearm(domainId));
		},
	};
}
