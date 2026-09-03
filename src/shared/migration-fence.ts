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
export const MIGRATION_IN_PROGRESS = "export-in-progress";

export type MigrationWindow = { fenced: boolean; epoch: number | null };

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
			const raw = fs.readFileSync(file, "utf8").trim();
			if (!/^[1-9][0-9]*$/.test(raw)) return 0;
			const epoch = Number(raw);
			return Number.isSafeInteger(epoch) ? epoch : 0;
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

export function readMigrationFenceRaisedAt(dataDir: string): number | null {
	try {
		return fs.statSync(path.join(dataDir, "migration-epoch")).mtimeMs;
	} catch {
		return null;
	}
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

function cachedMigrationEpoch(): number | null {
	const now = clock();
	if (now - cachedAt >= POLL_MS) {
		cachedEpoch = read();
		cachedAt = now;
	}
	return cachedEpoch;
}

export function readGatewayMigrationWindow(): MigrationWindow {
	const epoch = cachedMigrationEpoch();
	return { fenced: epoch !== null, epoch: epoch === 0 ? null : epoch };
}

/** Compatibility alias for writer guards. */
export function fenced(): boolean {
	return readGatewayMigrationWindow().fenced;
}

export function migrationInProgressFile(dataDir: string): string {
	return path.join(dataDir, MIGRATION_IN_PROGRESS);
}

function markerPid(marker: string): number | null {
	try {
		const value = Number.parseInt(fs.readFileSync(marker, "utf8").trim(), 10);
		return Number.isInteger(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function assertNoMigrationInProgress(dataDir: string): void {
	const marker = migrationInProgressFile(dataDir);
	if (!fs.existsSync(marker)) return;
	const pid = markerPid(marker);
	if (pid !== null && processAlive(pid))
		throw new Error(`migration operation already in progress: ${MIGRATION_IN_PROGRESS} pid ${pid}`);
	fs.rmSync(marker, { force: true });
}

export function withMigrationInProgress<T>(dataDir: string, operation: () => T): T {
	const marker = migrationInProgressFile(dataDir);
	fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	while (true) {
		try {
			const descriptor = fs.openSync(marker, "wx", 0o600);
			try {
				fs.writeFileSync(descriptor, `${process.pid}\n`);
			} finally {
				fs.closeSync(descriptor);
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			assertNoMigrationInProgress(dataDir);
		}
	}
	try {
		return operation();
	} finally {
		fs.rmSync(marker, { force: true });
	}
}

// Null means no fence or unknown epoch. The flag distinguishes those states.
// Grammar: bare decimal epoch; settle age uses the operator's clock and file mtime.
export function migrationFenceRaisedAt(): number | null {
	const now = clock();
	if (now - cachedAt >= POLL_MS) cachedMigrationEpoch();
	return raisedAt();
}
