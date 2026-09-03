import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cutExcludes } from "../../scripts/gateway-cut.js";

const roots: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cut-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("gateway cut", () => {
	it("defines the transient exclusion list", () => {
		const dataDir = tempDir();
		fs.writeFileSync(path.join(dataDir, "migration-epoch"), "7\n");
		fs.utimesSync(path.join(dataDir, "migration-epoch"), new Date(0), new Date(Date.now() - 61_000));
		const excluded = [".tmp.*", ".corrupt-*", "owner.lock", "import-in-progress", "export-in-progress"];
		for (const name of excluded) fs.writeFileSync(path.join(dataDir, name), "excluded");
		const args = cutExcludes("cut-7.tar", "cut-7.tar.tmp.12");
		for (const name of excluded) expect(args).toContain(name);
		expect(args).not.toContain("migration-epoch");
	});
});
