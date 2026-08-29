import fs from "node:fs";
import path from "node:path";
import { sweepAtomicTemps, writeFileAtomic } from "./atomic-write.js";

/** A checked snapshot reached its final pathname, but the directory sync could not be confirmed. */
export class DurableStoreInstalledError extends Error {
	constructor(cause: unknown) {
		super("durable snapshot was installed but its directory sync could not be confirmed", { cause });
		this.name = "DurableStoreInstalledError";
	}
}

////////////////////////////////
//  Class

/**
 * Atomic JSON snapshot to disk, reloaded on boot, so the gateway's in-memory delivery
 * state (pending-job anchors, device mailboxes) survives a restart/deploy instead of
 * vanishing - the durability gap behind the "no pending request" 404 after every gateway
 * rebuild and the loss of queued mail across a deploy.
 *
 * Snapshots are taken on a timer and on shutdown (SIGTERM), so a clean deploy loses
 * nothing and an unclean crash loses at most one interval. Best-effort: a disk hiccup is
 * swallowed, never crashing the gateway - durability must not become a liveness risk.
 */
export class DurableStore {
	private readonly file: string;
	private lastError: string | null = null;
	private quarantined = false;

	constructor(dir: string, name: string) {
		this.file = path.join(dir, `${name}.json`);
	}

	/** The persisted snapshot, or null if absent/unreadable (first boot, corrupt file). */
	load(): unknown | null {
		if (this.quarantined) return null;
		sweepAtomicTemps(path.dirname(this.file));
		try {
			return JSON.parse(fs.readFileSync(this.file, "utf8"));
		} catch {
			return null;
		}
	}

	/**
	 * Stop serving this file's contents for the rest of the process while still writing through, so
	 * the next save heals it. A consumer that these contents already poisoned cannot be handed them
	 * a second time, which is what makes retrying a build safe rather than a guaranteed re-throw.
	 */
	quarantine(): void {
		this.quarantined = true;
	}

	/** Atomic write that reports failure to callers whose state transition depends on durability. */
	saveChecked(state: unknown): void {
		this.writeAtomic(state, true);
	}

	/** Best-effort atomic write for periodic snapshots and shutdown persistence. */
	save(state: unknown): void {
		try {
			this.writeAtomic(state, false);
		} catch (e) {
			// Best-effort durability must never crash delivery, but a persistent write failure (full
			// or read-only disk) is otherwise invisible. Surface it once per distinct error so a
			// recurring failure does not spam every save interval; clear on the next success.
			const msg = e instanceof Error ? e.message : String(e);
			if (msg !== this.lastError) {
				this.lastError = msg;
				// Logging itself must never break the best-effort contract (a thrown console.error
				// would propagate out of this catch and crash the save).
				try {
					console.error(`[durable-store] save failed for ${path.basename(this.file)}: ${msg}`);
				} catch {}
			}
		}
	}

	private writeAtomic(state: unknown, durable: boolean): void {
		const serialized = JSON.stringify(state);
		if (serialized === undefined) throw new TypeError("durable state must be JSON serializable");
		writeFileAtomic(this.file, serialized, {
			fsyncFile: durable,
			fsyncDirectory: durable,
			// The snapshot is already at its final name by then, which the caller treats differently
			// from a write that never landed.
			onDirectorySyncError: (error) => {
				throw new DurableStoreInstalledError(error);
			},
		});
		this.lastError = null;
	}
}

////////////////////////////////
//  Functions & Helpers

/**
 * Build a consumer over a durable file, containing a poisoned file to that file alone.
 *
 * `load()` returning null already covers a file that does not parse. The gap this closes is a file
 * that parses fine and then throws inside its CONSUMER's restore, which is not hypothetical: a
 * `mailboxes.json` shaped `{phone:{epoch:"x"}}` throws on a missing `entries`, and a
 * `replay-guard.json` holding a bare number array throws on destructuring. Whoever restores several
 * files under one try loses every restore after the throwing one, and whoever restores under no try
 * fails the whole boot with no way to self-heal.
 */
export function openDurable<T>(dir: string, name: string, build: (store: DurableStore) => T): T {
	const store = new DurableStore(dir, name);
	try {
		return build(store);
	} catch (err) {
		console.error(`[durability] ${name} restore failed, starting fresh:`, err);
		store.quarantine();
		return build(store);
	}
}

/**
 * Run one already-built consumer's restore, contained. The sibling of `openDurable` for state that
 * is restored in place rather than at construction: same per-file containment, no rebuild. Without
 * it, neighbouring restores sharing one try are lost to whichever file throws first, and the
 * periodic persist then writes those empty consumers back over good files.
 */
export function restoreDurable(name: string, restore: () => void): void {
	try {
		restore();
	} catch (err) {
		console.error(`[durability] ${name} restore failed, starting fresh:`, err);
	}
}

/** One contained step of a persist pass: a save, a sweep, or the snapshot build feeding one. */
export interface PersistStep {
	name: string;
	run: () => void;
}

/**
 * The write-direction sibling of `restoreDurable`: run every step, each contained to itself, so one
 * failing save or sweep costs that step alone. A failure reports once per distinct error per step,
 * cleared on that step's next success (DurableStore.save's own throttle).
 */
export function createPersistRunner(): (steps: ReadonlyArray<PersistStep>) => void {
	const lastErrors = new Map<string, string>();
	return (steps) => {
		for (const step of steps) {
			try {
				step.run();
				lastErrors.delete(step.name);
			} catch (err) {
				// The coercion and the log are contained too: a thrown value with a poisoned toString
				// must not escape the runner it was caught by.
				let msg: string;
				try {
					msg = err instanceof Error ? err.message : String(err);
				} catch {
					msg = "unstringifiable error";
				}
				if (lastErrors.get(step.name) === msg) continue;
				lastErrors.set(step.name, msg);
				try {
					// A real Error keeps its stack; anything else logs as the already-safe string.
					console.error(`[persist] ${step.name} failed:`, err instanceof Error ? err : msg);
				} catch {}
			}
		}
	};
}
