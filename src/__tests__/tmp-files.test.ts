import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../shared/tmp-files.js";

let scratch: string | null = null;

afterEach(() => {
	if (scratch) {
		rmSync(scratch, { recursive: true, force: true });
		scratch = null;
	}
});

function makeScratch(): string {
	scratch = mkdtempSync(join(tmpdir(), "tmp-files-test-"));
	return scratch;
}

function backdate(path: string, ageMs: number): void {
	const past = new Date(Date.now() - ageMs);
	utimesSync(path, past, past);
}

describe("cleanupTmpDir", () => {
	it("mode 'files' unlinks files older than maxAgeMs and keeps fresh ones", () => {
		const dir = makeScratch();
		const stale = join(dir, "stale.bin");
		const fresh = join(dir, "fresh.bin");
		writeFileSync(stale, "x");
		writeFileSync(fresh, "x");
		backdate(stale, 10 * 60 * 1000);

		cleanupTmpDir({ dir, maxAgeMs: 5 * 60 * 1000, mode: "files" });

		const remaining = readdirSync(dir);
		expect(remaining).toContain("fresh.bin");
		expect(remaining).not.toContain("stale.bin");
	});

	it("mode 'dirs' rm -rf's stale child directories", () => {
		const dir = makeScratch();
		const staleDir = join(dir, "stale");
		const freshDir = join(dir, "fresh");
		mkdirSync(staleDir);
		mkdirSync(freshDir);
		writeFileSync(join(staleDir, "child"), "x");
		writeFileSync(join(freshDir, "child"), "x");
		backdate(staleDir, 10 * 60 * 1000);

		cleanupTmpDir({ dir, maxAgeMs: 5 * 60 * 1000, mode: "dirs" });

		const remaining = readdirSync(dir);
		expect(remaining).toContain("fresh");
		expect(remaining).not.toContain("stale");
	});

	it("is silent on a missing directory", () => {
		const missing = join(tmpdir(), `missing-${Date.now()}`);
		expect(() => cleanupTmpDir({ dir: missing, maxAgeMs: 1000, mode: "dirs" })).not.toThrow();
	});

	it("mode 'files' ignores directories (does not delete them)", () => {
		const dir = makeScratch();
		const subDir = join(dir, "subdir");
		mkdirSync(subDir);
		backdate(subDir, 10 * 60 * 1000);

		cleanupTmpDir({ dir, maxAgeMs: 5 * 60 * 1000, mode: "files" });

		expect(statSync(subDir).isDirectory()).toBe(true);
	});
});
