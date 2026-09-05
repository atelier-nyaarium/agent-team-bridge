import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import type { PresenceRow } from "../../shared/presence-identity.js";
import type { GatewaySpawnPoints } from "../../shared/types.js";
import { applyAnswer, nextFrame, type PresenceAnswer, type Sync } from "./presenceProtocol.js";

export interface PresenceReporterDeps {
	rows: () => PresenceRow[];
	spawnPoints: () => GatewaySpawnPoints;
	send: (action: string, params: Record<string, unknown>) => Promise<PresenceAnswer>;
	incarnation: () => number | null;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	debounceMs?: number;
	retryMs?: number;
}

const retryMsOf = (deps: PresenceReporterDeps): number => deps.retryMs ?? 30_000;

export function createPresenceReporter(deps: PresenceReporterDeps) {
	const now = () => deps.ambient.now();
	let sync: Sync = { at: "needsBaseline" };
	let dirty = false;
	let deadline: number | null = null;
	let timer: TimerHandle | null = null;
	let pumping = false;
	/** The spawn points the last landed baseline put on the wire. */
	let sentSpawns: string | null = null;
	let baselineWaiters: Array<() => void> = [];

	const wakeWaiters = (): void => {
		const waiters = baselineWaiters;
		baselineWaiters = [];
		for (const resolve of waiters) resolve();
	};

	const arm = (): void => {
		if (timer) deps.ambient.clearTimer(timer);
		timer = null;
		if (deadline === null) return;
		const delay = Math.max(0, deadline - now());
		timer = deps.ambient.setTimer(() => {
			timer = null;
			void pump();
		}, delay);
	};

	const setDeadline = (at: number | null): void => {
		deadline = at;
		arm();
	};

	const pump = async (): Promise<void> => {
		if (pumping) return;
		pumping = true;
		try {
			while (true) {
				if (deps.incarnation() === null) {
					wakeWaiters();
					return;
				}
				if (deadline !== null && now() < deadline) {
					arm();
					return;
				}
				// Spawn-point changes require a baseline.
				const spawns = deps.spawnPoints();
				if (sync.at === "streaming" && sentSpawns !== null && JSON.stringify(spawns) !== sentSpawns) {
					sync = { at: "needsBaseline" };
				}
				if (sync.at === "streaming" && !dirty) return;
				const frame = nextFrame(sync, deps.incarnation(), deps.rows(), spawns);
				if (frame === null) return;
				if (frame.at === "delta") dirty = false;
				setDeadline(null);
				const syncAtSend = sync;
				const action = frame.at === "baseline" ? "presence_baseline" : "presence_delta";
				const params =
					frame.at === "baseline"
						? { seq: 0, rows: frame.rows, spawnPoints: frame.spawnPoints }
						: { seq: frame.seq, upserts: frame.upserts, tombstones: frame.tombstones };
				const verdict = applyAnswer(syncAtSend, frame, await deps.send(action, params));
				if (sync !== syncAtSend) {
					if (sync.at === "needsBaseline") setDeadline(0);
					continue;
				}
				switch (verdict.at) {
					case "landed":
						sync = verdict.sync;
						// Record transmitted data, never a later re-read.
						if (frame.at === "baseline") sentSpawns = JSON.stringify(frame.spawnPoints);
						setDeadline(null);
						wakeWaiters();
						break;
					case "parked":
						sync = { at: "parked" };
						setDeadline(null);
						wakeWaiters();
						return;
					case "retry":
						sync = verdict.sync;
						dirty = true;
						if (frame.at === "baseline") wakeWaiters();
						setDeadline(now() + retryMsOf(deps));
						return;
					case "rebaseline":
						sync = { at: "needsBaseline" };
						setDeadline(0);
						break;
				}
			}
		} finally {
			pumping = false;
		}
	};

	const baseline = (): Promise<void> => {
		setDeadline(0);
		sync = { at: "needsBaseline" };
		const result = new Promise<void>((resolve) => baselineWaiters.push(resolve));
		void pump();
		return result;
	};

	const markDirty = (): void => {
		dirty = true;
		if (sync.at === "parked") return;
		// Armed deadlines never move later.
		if (deadline === null) setDeadline(now() + (deps.debounceMs ?? 250));
		void pump();
	};

	const resync = (): void => {
		sync = { at: "needsBaseline" };
		setDeadline(0);
		void pump();
	};

	const stop = (): void => {
		if (timer) deps.ambient.clearTimer(timer);
		timer = null;
		deadline = null;
		wakeWaiters();
	};

	return { baseline, markDirty, resync, stop };
}
