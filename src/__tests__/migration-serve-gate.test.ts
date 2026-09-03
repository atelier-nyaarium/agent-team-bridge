import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideServe } from "../federation-server/migration/serveGate.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration serve gate", () => {
	it("refuses to serve while an import is unverified", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-gate-"));
		roots.push(dir);

		expect(decideServe(dir)).toEqual({ kind: "serve" });

		fs.writeFileSync(path.join(dir, "import-in-progress"), "active", "utf8");
		expect(decideServe(dir)).toEqual({ kind: "refuse", reason: "import_unverified" });
	});
});
