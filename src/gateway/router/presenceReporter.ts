import type { PresenceRow } from "../../shared/presence-identity.js";
import type { GatewaySpawnPoints } from "../../shared/types.js";
import { applyAnswer, nextFrame, type PresenceAnswer, type Sync } from "./presenceProtocol.js";

export interface PresenceReporterDeps {
	rows: () => PresenceRow[];
	spawnPoints: () => GatewaySpawnPoints;
	send: (action: string, params: Record<string, unknown>) => Promise<PresenceAnswer>;
	incarnation: () => number | null;
	debounceMs?: number;
	retryMs?: number;
}

const retryMsOf = (deps: PresenceReporterDeps): number => deps.retryMs ?? 30_000;

export function createPresenceReporter(deps: PresenceReporterDeps) {
	let sync: Sync = { at: "needsBaseline" };
	let dirty = false;
	let deadline: number | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
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
		if (timer) clearTimeout(timer);
		timer = null;
		if (deadline === null) return;
		const delay = Math.max(0, deadline - Date.now());
		timer = setTimeout(() => {
			timer = null;
			void pump();
		}, delay);
		timer.unref?.();
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
				if (deadline !== null && Date.now() < deadline) {
					arm();
					return;
				}
				// Only a baseline carries spawn points, so a change to them has no delta to ride.
				// Force one rather than leaving the Router on whatever list the last baseline caught.
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
						// What actually went on the wire, never a re-read.
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
						setDeadline(Date.now() + retryMsOf(deps));
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
		// Never move an ARMED deadline later. A retry floor must not be lowered and a debounce window
		// must not be pushed out by the next mutation, and both meanings agree on that. Extending it
		// would make churn faster than the window starve presence entirely.
		if (deadline === null) setDeadline(Date.now() + (deps.debounceMs ?? 250));
		void pump();
	};

	const resync = (): void => {
		sync = { at: "needsBaseline" };
		setDeadline(0);
		void pump();
	};

	return { baseline, markDirty, resync };
}
