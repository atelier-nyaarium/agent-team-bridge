import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Class

/**
 * Atomic JSON snapshot to disk, reloaded on boot, so the arbiter's in-memory delivery
 * state (pending-job anchors, device mailboxes) survives a restart/deploy instead of
 * vanishing - the durability gap behind the "no pending request" 404 after every arbiter
 * rebuild and the loss of queued mail across a deploy.
 *
 * Snapshots are taken on a timer and on shutdown (SIGTERM), so a clean deploy loses
 * nothing and an unclean crash loses at most one interval. Best-effort: a disk hiccup is
 * swallowed, never crashing the arbiter - durability must not become a liveness risk.
 */
export class DurableStore {
	private readonly file: string;

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
		} catch {
			// Durability is best-effort; a disk error must never take down delivery.
		}
	}
}
