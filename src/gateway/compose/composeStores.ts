// Every durable writer the gateway owns, and what the last run left on disk.

import type { Ambient } from "../../shared/ambient.js";
import { BlobStore } from "../../shared/blob-store.js";
import { type BoardReply, isBoardReply } from "../../shared/board-structure.js";
import { DurableStore, openDurable, restoreDurable } from "../../shared/durable-store.js";
import { PendingDeliveryStore } from "../../shared/pending-delivery-store.js";
import { PendingJobStore } from "../../shared/pending-job-store.js";
import type { PlanePersistedState } from "../../shared/plane-registry.js";
import type { ResponsePayload } from "../../shared/types.js";
import { CapabilityStore } from "../console/capabilityStore.js";
import { DurableOpStore } from "../console/durableOpStore.js";
import { DaemonCapabilityStore } from "../daemonCapabilities.js";
import { createInboxClaims } from "../router/inboxClaims.js";

export interface StoresStageDeps {
	dataDir: string;
	maxBlobStoreBytes: number;
	ambient: Ambient;
	/** Runs whenever a job lands or settles, so the share attestation follows the live set. */
	onJobChange: () => void;
}

/** What the previous run persisted under session-resume. */
export interface RestoredState {
	sessions: unknown;
	planes: Record<string, PlanePersistedState> | undefined;
	readAnchors: unknown;
	crossDomainPresence: unknown;
}

export interface StoresStage {
	blobStore: BlobStore;
	maxBlobStoreBytes: number;
	jobs: PendingJobStore<ResponsePayload>;
	jobsDurable: DurableStore;
	durableOpStore: DurableOpStore;
	pendingDeliveries: PendingDeliveryStore;
	inboxClaims: ReturnType<typeof createInboxClaims>;
	boardReplays: DurableOpStore<BoardReply>;
	sessionResumeDurable: DurableStore;
	capabilityStore: CapabilityStore;
	daemonCapabilityStore: DaemonCapabilityStore;
	restored: RestoredState;
}

export function composeStores(deps: StoresStageDeps): StoresStage {
	const { dataDir, ambient } = deps;
	const blobStore = new BlobStore(`${dataDir}/blobs`, ambient);
	const jobs = new PendingJobStore<ResponsePayload>(600_000, ambient, deps.onJobChange);
	jobs.startCleanup();

	const jobsDurable = new DurableStore(dataDir, "pending-jobs");
	const durableOpStore = openDurable(dataDir, "op-idempotency", (d) => new DurableOpStore(d, ambient));
	const pendingDeliveries = openDurable(dataDir, "pending-deliveries", (d) => new PendingDeliveryStore(d, ambient));
	const inboxClaims = createInboxClaims(dataDir, ambient);
	const boardReplays = openDurable(dataDir, "board-idempotency", (d) =>
		DurableOpStore.withValidator<BoardReply>(d, ambient, isBoardReply),
	);
	const sessionResumeDurable = new DurableStore(dataDir, "session-resume");
	const capabilityStore = openDurable(dataDir, "console-capabilities", (d) => new CapabilityStore(d, ambient));
	const daemonCapabilityStore = openDurable(dataDir, "daemon-capabilities", (d) => new DaemonCapabilityStore(d));

	restoreDurable("pending-jobs", () => {
		const persisted = jobsDurable.load();
		if (Array.isArray(persisted)) jobs.restore(persisted as Parameters<typeof jobs.restore>[0]);
	});

	return {
		blobStore,
		maxBlobStoreBytes: deps.maxBlobStoreBytes,
		jobs,
		jobsDurable,
		durableOpStore,
		pendingDeliveries,
		inboxClaims,
		boardReplays,
		sessionResumeDurable,
		capabilityStore,
		daemonCapabilityStore,
		restored: readRestoredState(sessionResumeDurable),
	};
}

function readRestoredState(sessionResumeDurable: DurableStore): RestoredState {
	const raw = sessionResumeDurable.load();
	const wrapped = raw !== null && typeof raw === "object" && "sessions" in raw;
	if (!wrapped) return { sessions: raw, planes: undefined, readAnchors: undefined, crossDomainPresence: undefined };
	const record = raw as {
		sessions?: unknown;
		planes?: Record<string, PlanePersistedState>;
		readAnchors?: unknown;
		crossDomainPresence?: unknown;
	};
	return {
		sessions: record.sessions,
		planes: record.planes,
		readAnchors: record.readAnchors,
		crossDomainPresence: record.crossDomainPresence,
	};
}
