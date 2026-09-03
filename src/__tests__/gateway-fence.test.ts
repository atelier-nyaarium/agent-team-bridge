import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lowerFence, raiseFence } from "../../scripts/gateway-fence.js";
import {
	assertNoMigrationInProgress,
	MIGRATION_IN_PROGRESS,
	MIGRATION_SETTLE_MS,
	migrationInProgressFile,
	withMigrationInProgress,
} from "../shared/migration-fence.js";

const roots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-fence-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("gateway fence command", () => {
	it("raises and removes the exact epoch grammar", () => {
		const dir = tempDir();
		raiseFence(dir, 12);
		expect(fs.readFileSync(path.join(dir, "migration-epoch"), "utf8")).toBe("12\n");
		fs.utimesSync(path.join(dir, "migration-epoch"), new Date(0), new Date(Date.now() - MIGRATION_SETTLE_MS - 1));
		lowerFence(dir);
		expect(fs.existsSync(path.join(dir, "migration-epoch"))).toBe(false);
	});

	it("refuses a different epoch and a young fence removal", () => {
		const dir = tempDir();
		raiseFence(dir, 12);
		expect(() => raiseFence(dir, 13)).toThrow();
		expect(() => lowerFence(dir)).toThrow();
		expect(fs.readFileSync(path.join(dir, "migration-epoch"), "utf8")).toBe("12\n");
	});

	it("serializes operations and reclaims dead markers", () => {
		const dir = tempDir();
		withMigrationInProgress(dir, () => {
			expect(() => withMigrationInProgress(dir, () => undefined)).toThrow(
				`${MIGRATION_IN_PROGRESS} pid ${process.pid}`,
			);
		});
		fs.writeFileSync(migrationInProgressFile(dir), "999999\n");
		assertNoMigrationInProgress(dir);
		withMigrationInProgress(dir, () => undefined);
		expect(fs.existsSync(migrationInProgressFile(dir))).toBe(false);
	});
});
