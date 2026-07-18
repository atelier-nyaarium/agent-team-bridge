import crypto from "node:crypto";

////////////////////////////////
//  Interfaces & Types

/** A plane's version identity. `epoch` distinguishes one gateway process incarnation from a later
 * one (mirrors DeviceMailbox's own epoch: a receiver comparing against an unknown epoch treats the
 * plane as fully stale rather than diffing against a counter minted by a different process).
 * `counter` is monotonic within one epoch, incremented only when the plane's content actually
 * changed (see `identityOf`). */
export interface PlaneVersion {
	epoch: number;
	counter: number;
}

/** Durable identity a plane can be restored from across a graceful restart: its version plus the
 * content hash that version was last published at. `cleanShutdown` is stamped by the CALLER (the
 * process that knows whether it is exiting via SIGTERM/SIGINT vs. a crash) - the registry has no
 * process-lifecycle knowledge of its own. */
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
}

interface Waiter {
	presentedMap: ReadonlyMap<string, PlaneVersion>;
	settle: (woke: boolean) => void;
}

////////////////////////////////
//  Functions & Helpers

/** Random positive Int31 (mirrors device-mailbox.ts's mintEpoch - the console/peer wire parses
 * epoch as a signed 32-bit int, and equality-only comparison is the invariant these values need,
 * never ordering). */
function mintEpoch(): number {
	return 1 + Math.floor(Math.random() * 0x7ffffffe);
}

/** sha256 of a value, recursively sorting plain-object keys so semantically-identical content
 * hashes identically regardless of Map/object insertion order (which can legitimately differ
 * between a live process and a JSON-restored one). Does NOT reorder arrays - array order is
 * assumed semantically meaningful; a plane's `identityOf` must itself canonically sort any
 * collection whose order is not (e.g. session records, sorted by team before hashing). */
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

/**
 * One named, versioned, hash-gated state plane. Mutators never call `bump()` directly (that
 * would reproduce the callsite-driven "remember to announce" pattern this framework exists to
 * kill) - they call `markDirty()`, and `recompute()` (invoked by the registry after any dirty
 * mark, and periodically by the tripwire) is what actually decides whether the identity changed
 * and, if so, bumps the counter. A plane cannot forget to announce a real change because nothing
 * outside `recompute()` is allowed to advance the counter.
 */
class Plane<T> {
	readonly name: string;
	private readonly snapshotFn: () => T;
	private readonly identityOf: (snapshot: T) => string;
	private epoch: number;
	private counter = 0;
	private lastHash: string;
	private dirty = false;

	constructor(def: PlaneDefinition<T>, restored?: PlanePersistedState) {
		this.name = def.name;
		this.snapshotFn = def.snapshot;
		this.identityOf = def.identityOf;
		if (restored?.cleanShutdown) {
			this.epoch = restored.epoch;
			this.counter = restored.counter;
			// The persisted hash, NOT recomputed yet - reconcileOnBoot() does that explicitly, once
			// every plane is registered, so its one honest bump is a deliberate boot step rather than
			// a side effect of construction order.
			this.lastHash = restored.hash;
		} else {
			// No persisted state, or the last exit was not clean: the counter lineage cannot be
			// trusted (nothing proves what happened between the last persist tick and an
			// uncaughtException/SIGKILL), so a fresh epoch forces every peer/console to fully
			// resync rather than risk installing content behind what was already fanned out live.
			// The baseline hash is the CURRENT snapshot, computed now - this epoch's counter 0 IS
			// this content, so the first markDirty() after registration correctly sees "unchanged"
			// instead of spuriously bumping against an empty-string placeholder.
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

	/** Recompute identity and bump iff it changed. Returns true if a bump fired. Called by the
	 * registry right after any `markDirty()`, and on the tripwire's own slow tick (which recomputes
	 * unconditionally, catching a mutation that changed the hash without ever marking dirty - the
	 * escaped-write case the tripwire exists for). */
	recompute(force = false): boolean {
		if (!this.dirty && !force) return false;
		this.dirty = false;
		const hash = this.identityOf(this.snapshotFn());
		if (hash === this.lastHash) return false;
		this.lastHash = hash;
		this.counter += 1;
		return true;
	}

	/** Boot reconciliation for a CLEAN restart: recompute against the live boot-time state and bump
	 * once if it differs from the persisted hash (live-derived fields, e.g. a session's connection
	 * status, cannot survive a process exit even when the exit was graceful, so this is expected to
	 * fire whenever anything was live at shutdown - not a bug). No-op for a fresh epoch (nothing to
	 * reconcile against). */
	reconcileOnBoot(): boolean {
		return this.recompute(true);
	}

	persistedState(cleanShutdown: boolean): PlanePersistedState {
		// A clean-shutdown snapshot recomputes the hash fresh at the true moment of exit, so the
		// persisted hash reflects reality even if nothing marked dirty since the last regular tick.
		if (cleanShutdown) this.recompute(true);
		return { epoch: this.epoch, counter: this.counter, hash: this.lastHash, cleanShutdown };
	}

	snapshot(): T {
		return this.snapshotFn();
	}
}

/**
 * The plane registry: named, versioned, hash-gated snapshots multiplexed on the console poll
 * response (generalizing the domainVersion precedent), plus the shared wait primitive a held poll
 * races against a mailbox's own `waitForAppend`. One registry per gateway process.
 */
export class PlaneRegistry {
	private readonly planes = new Map<string, Plane<unknown>>();
	private waiters: Waiter[] = [];

	/** Register a plane once. `identityOf` must be a pure function of `snapshot()`'s return value,
	 * and must canonically order any collection inside it whose iteration order is not itself
	 * semantically meaningful (session records, sub-plane maps) - two calls with equivalent content
	 * must hash identically regardless of Map/object insertion order. */
	registerPlane<T>(def: PlaneDefinition<T>, restored?: PlanePersistedState): void {
		if (this.planes.has(def.name)) throw new Error(`plane "${def.name}" already registered`);
		this.planes.set(def.name, new Plane(def, restored) as Plane<unknown>);
	}

	/** Mark a plane dirty and immediately recompute (mutators call this; it is the ONLY path that
	 * can advance a plane's counter, so a write that never calls it cannot announce itself outside
	 * the tripwire's own periodic catch-up). Wakes every held poll whose presented version for this
	 * plane no longer matches. */
	markDirty(name: string): void {
		const plane = this.planes.get(name);
		if (!plane) return;
		plane.markDirty();
		if (plane.recompute()) this.wake(name);
	}

	version(name: string): PlaneVersion | undefined {
		return this.planes.get(name)?.version;
	}

	snapshot<T>(name: string): T | undefined {
		return this.planes.get(name)?.snapshot() as T | undefined;
	}

	/** Every plane whose CURRENT version differs from what the caller presented (behind, ahead, or
	 * an unrecognized epoch alike - see PollWaitHub's own doc for why "ahead" is not special-cased). */
	changedSince(presented: ReadonlyMap<string, PlaneVersion>): string[] {
		const changed: string[] = [];
		for (const [name, plane] of this.planes) {
			const have = presented.get(name);
			const cur = plane.version;
			if (!have || have.epoch !== cur.epoch || have.counter !== cur.counter) changed.push(name);
		}
		return changed;
	}

	/** Resolve when ANY registered plane's version diverges from `presented`, or `timeoutMs` elapses
	 * - whichever first. Mirrors DeviceMailbox.waitForAppend's shape exactly (a waiters array + one
	 * timer per waiter), deliberately a SEPARATE mechanism from the mailbox's own waiters rather than
	 * sharing that array: presence and messages are different subsystems, and racing two independent
	 * primitives via `Promise.race` at the one call site (the poll op) is safer than coupling them.
	 * Returns true if a real bump woke it, false on timeout - callers use this to decide whether a
	 * response actually changed. Registration happens synchronously (no `await` between the
	 * changed-check and pushing the waiter), so a bump landing between "the caller checked" and "the
	 * caller starts waiting" is structurally impossible - JS's single-threaded execution IS the lock. */
	waitForBump(presented: ReadonlyMap<string, PlaneVersion>, timeoutMs: number): Promise<boolean> {
		if (this.changedSince(presented).length > 0) return Promise.resolve(true);
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiter: Waiter = {
				presentedMap: presented,
				settle: (woke) => {
					clearTimeout(timer);
					const i = this.waiters.indexOf(waiter);
					if (i >= 0) this.waiters.splice(i, 1);
					resolve(woke);
				},
			};
			timer = setTimeout(() => waiter.settle(false), timeoutMs);
			this.waiters.push(waiter);
		});
	}

	private wake(planeName: string): void {
		const cur = this.planes.get(planeName)?.version;
		if (!cur) return;
		for (const waiter of [...this.waiters]) {
			// A waiter that never mentioned this plane at all is not tracking it (a legacy client
			// presenting only `domainVersion`, or one from before a phase-2 plane existed) - waking it
			// would just be a wasted round trip, not a correctness fix. Only a STALE presented value
			// for a plane the waiter actually asked about is grounds to wake.
			if (!waiter.presentedMap.has(planeName)) continue;
			const have = waiter.presentedMap.get(planeName);
			if (!have || have.epoch !== cur.epoch || have.counter !== cur.counter) waiter.settle(true);
		}
	}

	/** The tripwire: recompute every plane unconditionally (not gated on markDirty) and bump+log any
	 * whose hash moved without a prior markDirty ever having caught it - a mutation that escaped the
	 * facade. Self-heals (the bump fires here, same as any other) rather than leaving the plane
	 * silently stale forever. Call on a slow tick, never the per-poll hot path. */
	tripwireTick(): void {
		for (const [name, plane] of this.planes) {
			if (plane.recompute(true)) {
				console.warn(`[plane-registry] tripwire caught an unmarked mutation on plane "${name}" - self-healed`);
				this.wake(name);
			}
		}
	}

	/** Boot reconciliation for every plane restored from a CLEAN shutdown (a fresh-epoch plane has
	 * nothing to reconcile - its whole point is "everyone must full-resync"). Call once at startup,
	 * after every plane is registered. */
	reconcileOnBoot(): void {
		for (const [name, plane] of this.planes) {
			if (plane.reconcileOnBoot()) console.log(`[plane-registry] "${name}" reconciled on boot (one honest bump)`);
		}
	}

	/** This process's full persisted state, bundled into whatever ONE atomic file the caller writes
	 * alongside its other durable state (never a separate sidecar file - see plan). */
	persistedState(cleanShutdown: boolean): Record<string, PlanePersistedState> {
		const out: Record<string, PlanePersistedState> = {};
		for (const [name, plane] of this.planes) out[name] = plane.persistedState(cleanShutdown);
		return out;
	}
}
