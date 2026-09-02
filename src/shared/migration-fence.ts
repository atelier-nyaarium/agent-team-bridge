// The migration fence. While it is up, every writer of MIGRATED state refuses, so the snapshot cut
// is taken over a tree nothing is still changing.
//
// Guarded AT THE WRITER, never at its callers. A route added later that reaches a fenced writer is
// covered by construction, which is what the residue test over writers pins.

import fs from "node:fs";
import path from "node:path";

/** Retryable: the caller may try again once the migration window closes. */
export const MIGRATING = "migrating";

/** How long a filesystem answer is trusted, so a write does not stat. */
const POLL_MS = 1000;

/** How long an op the fence caught mid-flight is given to reach its own terminal state. */
export const MIGRATION_SETTLE_MS = 60_000;

let read: () => number | null = () => null;
let cachedEpoch: number | null = null;
let cachedAt = -Infinity;
let clock: () => number = () => Date.now();

/** Reads `DATA_DIR/migration-epoch`. Wired once at boot. */
export function useMigrationEpochFile(dataDir: string): void {
	const file = path.join(dataDir, "migration-epoch");
	read = () => {
		try {
			const epoch = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
			return Number.isFinite(epoch) ? epoch : null;
		} catch {
			// Absent is the normal case and means the fence is down. An unreadable file is not: it
			// cannot be told from a present one, so it fences rather than opening the gate on an error.
			return fs.existsSync(file) ? 0 : null;
		}
	};
	invalidate();
}

/** Sets the fence directly, for tests and for a gateway told to fence over the wire. */
export function setMigrationEpoch(epoch: number | null): void {
	read = () => epoch;
	invalidate();
}

/** Drops the cached answer, so the next read hits the source. */
export function invalidate(): void {
	cachedAt = -Infinity;
}

/** Test seam for the poll window. */
export function useMigrationClock(next: () => number): void {
	clock = next;
	invalidate();
}

export function migrationEpoch(): number | null {
	const now = clock();
	if (now - cachedAt >= POLL_MS) {
		cachedEpoch = read();
		cachedAt = now;
	}
	return cachedEpoch;
}

/** True while migrated state must not be written. */
export function fenced(): boolean {
	return migrationEpoch() !== null;
}
