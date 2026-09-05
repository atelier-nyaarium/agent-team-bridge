import crypto from "node:crypto";
import type { Ambient, TimerHandle } from "./ambient.js";
import { mintEpoch } from "./epoch.js";

////////////////////////////////
//  Interfaces & Types

/** `epoch` distinguishes one process incarnation from a later one. */
export interface PlaneVersion {
	epoch: number;
	counter: number;
}

/** `cleanShutdown` is stamped by the CALLER: the registry has no process-lifecycle knowledge. */
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
	/** The one hook outside waitForBump for a plane that must react to its own change. */
	onBump?: (version: PlaneVersion) => void;
}

interface Waiter {
	presentedMap: ReadonlyMap<string, PlaneVersion>;
	settle: (woke: boolean) => void;
}

////////////////////////////////
//  Functions & Helpers

/** Mirrors device-mailbox.ts's mintEpoch. Equality-only, never ordering. */
/** Keys sorted, arrays NOT: array order is assumed meaningful, so `identityOf` must sort its own
 * unordered collections before hashing. */
export function stableHash(value: unknown): string {
	return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

////////////////////////////////
//  Class

/** Mutators call `markDirty()`, never bump directly: nothing outside `recompute()` may advance
 * the counter, so a plane cannot forget to announce a real change. */
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
			// Not recomputed yet: reconcileOnBoot() does that once every plane is registered.
			this.lastHash = restored.hash;
		} else {
			// An unclean exit cannot trust the counter lineage, so a fresh epoch forces a full resync.
			this.epoch = mintEpoch();
			this.lastHash = this.identityOf(this.snapshotFn());
		}
	}

	get version(): PlaneVersion {
		return { epoch: this.epoch, counter: this.counter };
	}

	markDirty(): void {
		this.dirty = true;
	}

	/** True if a bump fired. `force` catches an escaped write that never marked dirty. */
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

	/** Live-derived fields never survive an exit, so this is expected to fire, not a bug. */
	reconcileOnBoot(): boolean {
		return this.recompute(true);
	}

	persistedState(cleanShutdown: boolean): PlanePersistedState {
		// The true moment of exit, even if nothing marked dirty since the last tick.
		if (cleanShutdown) this.recompute(true);
		return { epoch: this.epoch, counter: this.counter, hash: this.lastHash, cleanShutdown };
	}

	snapshot(): T {
		return this.snapshotFn();
	}
}

/** Multiplexed on the console poll response, plus the wait primitive a held poll races against a
 * mailbox's own `waitForAppend`. One registry per process. */
export class PlaneRegistry {
	private readonly planes = new Map<string, Plane<unknown>>();
	private waiters: Waiter[] = [];
	private readonly coalesceTimers = new Map<string, TimerHandle>();

	constructor(private readonly ambient: Pick<Ambient, "setTimer" | "clearTimer">) {}

	/** `identityOf` must be pure and canonically order any unordered collection inside it. */
	registerPlane<T>(def: PlaneDefinition<T>, restored?: PlanePersistedState): void {
		if (this.planes.has(def.name)) throw new Error(`plane "${def.name}" already registered`);
		this.planes.set(def.name, new Plane(def, restored) as Plane<unknown>);
	}

	/** For a caller that registers planes LAZILY, since a second registerPlane throws. */
	hasPlane(name: string): boolean {
		return this.planes.has(name);
	}

	/** For a plane shorter-lived than the process. Wakes, never times out, any waiter tracking it. */
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

	/** The ONLY path that can advance a counter. Wakes every held poll whose version no longer
	 * matches. */
	markDirty(name: string): void {
		const plane = this.planes.get(name);
		if (!plane) return;
		plane.markDirty();
		if (plane.recompute()) this.wake(name);
	}

	/** Folds a write burst into one bump. On the registry, not a call-site debounce, so a mutator
	 * cannot forget the flush. */
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

	/** `scope` matters once more than one plane exists: without it, "not tracked" and "unknown, ship
	 * it" are indistinguishable from an absent presented-map key. */
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

	/** No `await` between check and push, so the check and registration stay atomic. */
	waitForBump(
		presented: ReadonlyMap<string, PlaneVersion>,
		timeoutMs: number,
		scope?: ReadonlySet<string>,
	): Promise<boolean> {
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
			// A waiter with no key for this plane is not tracking it.
			if (!waiter.presentedMap.has(planeName)) continue;
			const have = waiter.presentedMap.get(planeName);
			if (!have || have.epoch !== cur.epoch || have.counter !== cur.counter) waiter.settle(true);
		}
	}

	/** Self-heals a mutation that escaped markDirty. Call on a slow tick, never the hot path.
	 *
	 * Each plane's recompute is isolated: an uncaught throw here runs inside a bare setInterval with
	 * nothing to catch it, taking the whole gateway down. One broken plane keeps running everything
	 * else. */
	tripwireTick(): void {
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

	/** Call once at startup, after every plane is registered. */
	reconcileOnBoot(): void {
		for (const [name, plane] of this.planes) {
			if (plane.reconcileOnBoot()) console.log(`[plane-registry] "${name}" reconciled on boot (one honest bump)`);
		}
	}

	/** Bundled into the caller's one atomic file, never a separate sidecar. */
	persistedState(cleanShutdown: boolean): Record<string, PlanePersistedState> {
		const out: Record<string, PlanePersistedState> = {};
		for (const [name, plane] of this.planes) out[name] = plane.persistedState(cleanShutdown);
		return out;
	}
}
