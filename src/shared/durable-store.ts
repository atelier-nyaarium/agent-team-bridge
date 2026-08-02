import fs from "node:fs";
import path from "node:path";

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
		const directory = path.dirname(this.file);
		fs.mkdirSync(directory, { recursive: true });
		const tmp = `${this.file}.tmp.${process.pid}`;
		let renamed = false;
		try {
			const descriptor = fs.openSync(tmp, "w");
			try {
				fs.writeFileSync(descriptor, serialized);
				if (durable) fs.fsyncSync(descriptor);
			} finally {
				fs.closeSync(descriptor);
			}
			fs.renameSync(tmp, this.file);
			renamed = true;
			if (durable && process.platform !== "win32") {
				const directoryDescriptor = fs.openSync(directory, "r");
				try {
					fs.fsyncSync(directoryDescriptor);
				} finally {
					fs.closeSync(directoryDescriptor);
				}
			}
			this.lastError = null;
		} catch (error) {
			if (!renamed) {
				try {
					fs.unlinkSync(tmp);
				} catch {}
				throw error;
			}
			if (durable) throw new DurableStoreInstalledError(error);
			throw error;
		}
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
