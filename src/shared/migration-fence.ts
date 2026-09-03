// Migration fence.
// Writers, never callers, enforce the fence. New routes inherit coverage. Residue tests pin it.

import fs from "node:fs";
import path from "node:path";

/** Retry after migration. */
export const MIGRATING = "migrating";

/** Cache window. */
const POLL_MS = 1000;

/** Mid-flight settle window. */
export const MIGRATION_SETTLE_MS = 60_000;

let read: () => number | null = () => null;
let raisedAt: () => number | null = () => null;
let cachedEpoch: number | null = null;
let cachedAt = -Infinity;
let clock: () => number = () => Date.now();

/** Read the migration epoch. */
export function useMigrationEpochFile(dataDir: string): void {
	const file = path.join(dataDir, "migration-epoch");
	read = () => {
		try {
			const epoch = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
			return Number.isFinite(epoch) ? epoch : null;
		} catch {
			// Unreadable epoch files fence like present ones.
			return fs.existsSync(file) ? 0 : null;
		}
	};
	raisedAt = () => {
		try {
			const stat = fs.statSync(file);
			return stat.mtimeMs;
		} catch {
			return null;
		}
	};
	invalidate();
}

/** Set the fence directly. */
export function setMigrationEpoch(epoch: number | null): void {
	read = () => epoch;
	raisedAt = () => null;
	invalidate();
}

/** Drop the cached answer. */
export function invalidate(): void {
	cachedAt = -Infinity;
}

/** Set the clock seam. */
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

/** Whether migrated state is fenced. */
export function fenced(): boolean {
	return migrationEpoch() !== null;
}

// Decimal epoch. Mtime marks raising.
// Grammar: bare decimal epoch; settle age uses the operator's clock and file mtime.
export function migrationFenceRaisedAt(): number | null {
	const now = clock();
	if (now - cachedAt >= POLL_MS) migrationEpoch();
	return raisedAt();
}
