import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

////////////////////////////////
//  Interfaces & Types

export interface CleanupTmpDirParams {
	dir: string;
	maxAgeMs: number;
	mode: "files" | "dirs";
}

////////////////////////////////
//  Functions & Helpers

/**
 * Sweep stale entries out of a tmp directory.
 *
 * - mode "files": unlinks individual files whose mtime is older than maxAgeMs.
 * - mode "dirs":  recursively removes child directories whose mtime is older than maxAgeMs.
 *
 * Idempotent and silent on missing dir or per-entry errors so callers can invoke
 * lazily on every write without guarding.
 */
export function cleanupTmpDir({ dir, maxAgeMs, mode }: CleanupTmpDirParams): void {
	if (!existsSync(dir)) return;

	const cutoff = Date.now() - maxAgeMs;

	for (const entry of readdirSync(dir)) {
		const entryPath = join(dir, entry);
		try {
			const stat = statSync(entryPath);
			if (stat.mtimeMs > cutoff) continue;

			if (mode === "files" && stat.isFile()) {
				unlinkSync(entryPath);
			} else if (mode === "dirs" && stat.isDirectory()) {
				rmSync(entryPath, { recursive: true, force: true });
			}
		} catch {}
	}
}
