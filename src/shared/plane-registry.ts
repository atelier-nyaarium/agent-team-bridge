import crypto from "node:crypto";
import type { Ambient, TimerHandle } from "./ambient.js";
import { mintEpoch } from "./epoch.js";

export interface PlaneVersion {
	/** Epochs compare for equality, never ordering. */
	epoch: number;
	counter: number;
}

export interface PlanePersistedState {
	epoch: number;
	counter: number;
	hash: string;
	cleanShutdown: boolean;
}

interface PlaneDefinition<T> {
	name: string;
	snapshot: () => T;
	identityOf: (snapshot: T) => string;
	onBump?: (version: PlaneVersion) => void;
}

interface Waiter {
	presentedMap: ReadonlyMap<string, PlaneVersion>;
	settle: (woke: boolean) => void;
}

export function stableHash(value: unknown): string {
	// Object keys sort; array order remains meaningful.
	return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

class Plane<T> {
	readonly name: string;
	private readonly snapshotFn: () => T;
	private readonly identityOf: (snapshot: T) => string;
	private readonly onBumpFn?: (version: PlaneVersion) => void;
	private epoch: number;
	private counter = 0;
	private lastHash: string;
	private dirty = false;

	constructor(def: PlaneDefinition<T>, restored?: PlanePersistedState) {
		this.name = def.name;
		this.snapshotFn = def.snapshot;
		this.identityOf = def.identityOf;
		this.onBumpFn = def.onBump;
		if (restored?.cleanShutdown) {
			this.epoch = restored.epoch;
			this.counter = restored.counter;
			this.lastHash = restored.hash;
		} else {
			// Unclean exits mint a fresh epoch for full resync.
			this.epoch = mintEpoch();
			this.lastHash = this.identityOf(this.snapshotFn());
		}
	}

	get version(): PlaneVersion {
		return { epoch: this.epoch, counter: this.counter };
	}

	markDirty(): void {
		// Only recompute may advance a counter.
		this.dirty = true;
	}

	recompute(force = false): boolean {
		if (!this.dirty && !force) return false;
		this.dirty = false;
		const hash = this.identityOf(this.snapshotFn());
		if (hash === this.lastHash) return false;
		this.lastHash = hash;
		this.counter += 1;
		this.onBumpFn?.(this.version);
		return true;
	}

	reconcileOnBoot(): boolean {
		return this.recompute(true);
	}

	persistedState(cleanShutdown: boolean): PlanePersistedState {
		if (cleanShutdown) this.recompute(true);
		return { epoch: this.epoch, counter: this.counter, hash: this.lastHash, cleanShutdown };
	}

	snapshot(): T {
		return this.snapshotFn();
	}
}

export class PlaneRegistry {
	private readonly planes = new Map<string, Plane<unknown>>();
	private waiters: Waiter[] = [];
	private readonly coalesceTimers = new Map<string, TimerHandle>();

	constructor(private readonly ambient: Pick<Ambient, "setTimer" | "clearTimer">) {}

	registerPlane<T>(def: PlaneDefinition<T>, restored?: PlanePersistedState): void {
		if (this.planes.has(def.name)) throw new Error(`plane "${def.name}" already registered`);
		this.planes.set(def.name, new Plane(def, restored) as Plane<unknown>);
	}

	hasPlane(name: string): boolean {
		return this.planes.has(name);
	}

	unregisterPlane(name: string): void {
		if (!this.planes.delete(name)) return;
		const pending = this.coalesceTimers.get(name);
		if (pending) {
			this.ambient.clearTimer(pending);
			this.coalesceTimers.delete(name);
		}
		for (const waiter of [...this.waiters]) {
			if (waiter.presentedMap.has(name)) waiter.settle(true);
		}
	}

	markDirty(name: string): void {
		const plane = this.planes.get(name);
		if (!plane) return;
		plane.markDirty();
		if (plane.recompute()) this.wake(name);
	}

	markDirtyCoalesced(name: string, windowMs: number): void {
		const plane = this.planes.get(name);
		if (!plane) return;
		plane.markDirty();
		if (this.coalesceTimers.has(name)) return;
		this.coalesceTimers.set(
			name,
			this.ambient.setTimer(() => {
				this.coalesceTimers.delete(name);
				const p = this.planes.get(name);
				if (p?.recompute()) this.wake(name);
			}, windowMs),
		);
	}

	version(name: string): PlaneVersion | undefined {
		return this.planes.get(name)?.version;
	}

	snapshot<T>(name: string): T | undefined {
		return this.planes.get(name)?.snapshot() as T | undefined;
	}

	changedSince(presented: ReadonlyMap<string, PlaneVersion>, scope?: ReadonlySet<string>): string[] {
		const changed: string[] = [];
		for (const [name, plane] of this.planes) {
			if (scope && !scope.has(name)) continue;
			const have = presented.get(name);
			const cur = plane.version;
			if (!have || have.epoch !== cur.epoch || have.counter !== cur.counter) changed.push(name);
		}
		return changed;
	}

	waitForBump(
		presented: ReadonlyMap<string, PlaneVersion>,
		timeoutMs: number,
		scope?: ReadonlySet<string>,
	): Promise<boolean> {
		// Check and waiter registration stay synchronous.
		if (this.changedSince(presented, scope).length > 0) return Promise.resolve(true);
		return new Promise((resolve) => {
			let timer: TimerHandle | undefined;
			const waiter: Waiter = {
				presentedMap: presented,
				settle: (woke) => {
					if (timer) this.ambient.clearTimer(timer);
					const i = this.waiters.indexOf(waiter);
					if (i >= 0) this.waiters.splice(i, 1);
					resolve(woke);
				},
			};
			timer = this.ambient.setTimer(() => waiter.settle(false), timeoutMs);
			this.waiters.push(waiter);
		});
	}

	private wake(planeName: string): void {
		const cur = this.planes.get(planeName)?.version;
		if (!cur) return;
		for (const waiter of [...this.waiters]) {
			if (!waiter.presentedMap.has(planeName)) continue;
			const have = waiter.presentedMap.get(planeName);
			if (!have || have.epoch !== cur.epoch || have.counter !== cur.counter) waiter.settle(true);
		}
	}

	tripwireTick(): void {
		// Isolate broken planes so one recompute cannot stop the tick.
		for (const [name, plane] of this.planes) {
			try {
				if (plane.recompute(true)) {
					console.warn(
						`[plane-registry] tripwire caught an unmarked mutation on plane "${name}" - self-healed`,
					);
					this.wake(name);
				}
			} catch (err) {
				console.error(`[plane-registry] tripwire threw recomputing plane "${name}" - skipping this tick:`, err);
			}
		}
	}

	reconcileOnBoot(): void {
		for (const [name, plane] of this.planes) {
			if (plane.reconcileOnBoot()) console.log(`[plane-registry] "${name}" reconciled on boot (one honest bump)`);
		}
	}

	persistedState(cleanShutdown: boolean): Record<string, PlanePersistedState> {
		const out: Record<string, PlanePersistedState> = {};
		for (const [name, plane] of this.planes) out[name] = plane.persistedState(cleanShutdown);
		return out;
	}
}
