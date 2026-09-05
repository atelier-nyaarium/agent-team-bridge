// Stage 4: the flush every writer takes part in, and the periodic tick that runs it.

import { createPersistRunner } from "../../shared/durable-store.js";
import { fenced, MIGRATION_SETTLE_MS } from "../../shared/migration-fence.js";
import { resolveLiveIncarnation } from "../websocket.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { FederationContext } from "./federationContext.js";

const SESSION_RESUME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_RESUME_ENTRIES = 2_000;

export interface PersistenceStageDeps {
	now: () => number;
	stores: StoresStage;
	sessions: SessionsStage;
	context: FederationContext;
}

export interface PersistenceStage {
	/** Runs every writer's step in order. A clean shutdown writes checked snapshots. */
	persistDelivery: (cleanShutdown: boolean) => void;
	persistTimer: ReturnType<typeof setInterval>;
}

export function composePersistence({ now, stores, sessions, context }: PersistenceStageDeps): PersistenceStage {
	const runPersistSteps = createPersistRunner();
	const persistDelivery = (cleanShutdown: boolean) =>
		runPersistSteps([
			{
				name: "pending-jobs",
				run: () =>
					cleanShutdown
						? stores.jobsDurable.saveChecked(stores.jobs.snapshot())
						: stores.jobsDurable.save(stores.jobs.snapshot()),
			},
			{
				name: "session-sweep",
				run: () => {
					const sweptTeams = sessions.sessionStore.sweep(SESSION_RESUME_TTL_MS, {
						maxEntries: MAX_SESSION_RESUME_ENTRIES,
						isLive: (team) =>
							resolveLiveIncarnation(sessions.registry, sessions.sessionStore, team) !== undefined,
					});
					if (sweptTeams.length === 0) return;
					for (const team of sweptTeams) void context.slice()?.boardClient.sessionEnded(team, "release");
					sessions.presence.markDirty();
				},
			},
			{ name: "op-idempotency-sweep", run: () => stores.durableOpStore.sweep() },
			{ name: "board-idempotency-sweep", run: () => stores.boardReplays.sweep() },
			{ name: "console-capabilities-sweep", run: () => stores.capabilityStore.sweep() },
			{
				name: "blob-sweep",
				run: () => {
					const freed = stores.blobStore.sweep({ maxBytes: stores.maxBlobStoreBytes });
					if (freed > 0) console.error(`[blobs] swept ${freed} bytes`);
				},
			},
			{
				name: "session-resume",
				run: () =>
					cleanShutdown
						? stores.sessionResumeDurable.saveChecked(sessions.sessionResumeSnapshot(cleanShutdown))
						: stores.sessionResumeDurable.save(sessions.sessionResumeSnapshot(cleanShutdown)),
			},
			{ name: "replay-guard", run: () => context.slice()?.replayPersist() },
		]);

	// Shutdown flush persists under the fence. Shut down before cutting.
	let fencedSince: number | null = null;
	let settled = false;
	const persistTimer = setInterval(() => {
		if (!fenced()) {
			fencedSince = null;
			settled = false;
			persistDelivery(false);
			return;
		}
		fencedSince ??= now();
		if (settled || now() - fencedSince < MIGRATION_SETTLE_MS) return;
		settled = true;
		const dropped = stores.durableOpStore.failInFlight(true);
		console.log(`[migration] settled: ${dropped} in-flight op(s) dropped for the client to re-run`);
	}, 3_000);
	persistTimer.unref?.();

	return { persistDelivery, persistTimer };
}
