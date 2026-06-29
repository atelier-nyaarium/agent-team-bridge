import fs from "node:fs";
import path from "node:path";

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

	constructor(dir: string, name: string) {
		this.file = path.join(dir, `${name}.json`);
	}

	/** The persisted snapshot, or null if absent/unreadable (first boot, corrupt file). */
	load(): unknown | null {
		try {
			return JSON.parse(fs.readFileSync(this.file, "utf8"));
		} catch {
			return null;
		}
	}

	/** Atomic write: a partial file from a crash mid-write is never read (tmp + rename). */
	save(state: unknown): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const tmp = `${this.file}.tmp.${process.pid}`;
			fs.writeFileSync(tmp, JSON.stringify(state));
			fs.renameSync(tmp, this.file);
			this.lastError = null;
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
}
