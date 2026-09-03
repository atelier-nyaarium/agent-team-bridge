import path from "node:path";
import { describe, expect, it } from "vitest";
import { foldWriteResult } from "../shared/write-result.js";
import { filesUnder, linesMatching } from "./helpers/residue.js";

describe("foldWriteResult", () => {
	it("treats an unsynced line as applied and a quarantine as uncertain", () => {
		expect(foldWriteResult({ kind: "ok" })).toEqual({ applied: true, outcome: "accepted" });
		expect(foldWriteResult({ kind: "durability_uncertain" })).toEqual({
			applied: true,
			outcome: "durability_uncertain",
		});
		expect(foldWriteResult({ kind: "conflict" })).toEqual({ applied: false, outcome: "conflict" });
		expect(foldWriteResult({ kind: "durability_failure" })).toEqual({
			applied: false,
			outcome: "durability_failure",
		});
		expect(foldWriteResult({ kind: "quarantined" })).toEqual({ applied: false, outcome: "durability_uncertain" });
	});

	it("refuses an arm it does not know", () => {
		expect(() => foldWriteResult({ kind: "later" } as never)).toThrow(/unhandled write result/);
	});

	it("keeps store results behind the shared fold", () => {
		const roots = ["presence", "tier1"].map((name) => path.join(process.cwd(), "src/federation-server", name));
		const comparison = /kind\s*(?:!==|===)\s*["']ok["']/;
		const offenders = roots.flatMap((root) =>
			filesUnder(root, ".ts").flatMap((file) => linesMatching(file, comparison)),
		);
		expect(offenders).toEqual([]);
	});
});
