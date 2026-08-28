import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRefFile } from "../mcp/references/refFile.js";
import { resolveRefs } from "../mcp/references/refResolve.js";
import { scanRefs } from "../mcp/references/refScanner.js";
import type { WorkspaceRoot } from "../mcp/references/refWorkspace.js";

////////////////////////////////
//  Functions & Helpers

let root: string;
let workspace: WorkspaceRoot;

/** A session that must never be opened: the ref under test is decided before the daemon. */
const unopened = async () => {
	throw new Error("the daemon was asked");
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ref-resolve-"));
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "cart.ts"), "export class Cart {\n\tadd(): void {}\n}\n");
	workspace = { root, admitted: true };
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("resolving before the daemon is reached", () => {
	it("degrades as warming, without opening a session, once the reply's budget is spent", async () => {
		const { refs } = scanRefs("[add](ref://src/cart.ts:Cart:add)");

		const outcome = await resolveRefs(refs, { workspace, session: unopened, load: loadRefFile, deadline: 0 });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.resolved[0]?.resolution).toMatchObject({ quality: "fuzzy", startLine: 2 });
		expect(outcome.resolved[0]?.resolution.reason).toContain("budget ran out");
		expect(outcome.notices).toEqual([expect.stringContaining("send again")]);
	});

	it("stops waiting on the index when the budget runs out mid-ask", async () => {
		const { refs } = scanRefs("[add](ref://src/cart.ts:Cart:add)");
		const hung = async () =>
			({ resolveChain: () => new Promise(() => {}), awaitIndexed: () => new Promise(() => {}) }) as never;
		const started = Date.now();

		const outcome = await resolveRefs(refs, {
			workspace,
			session: hung,
			load: loadRefFile,
			deadline: started + 60,
		});

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(outcome.ok && outcome.resolved[0]?.resolution).toMatchObject({ quality: "fuzzy" });
		expect(outcome.ok && outcome.notices[0]).toContain("send again");
	});

	it("files two spellings of one file under the first spelling, so one snapshot ships", async () => {
		const { refs } = scanRefs("[a](ref://src/cart.ts) and [b](ref://./src/cart.ts#add)");

		const outcome = await resolveRefs(refs, {
			workspace,
			session: unopened,
			load: loadRefFile,
			deadline: Date.now() + 1_000,
		});

		expect(outcome.ok && outcome.resolved.map((r) => r.refPath)).toEqual(["src/cart.ts", "src/cart.ts"]);
		expect(outcome.ok && outcome.resolved.map((r) => r.found.key)).toEqual([
			"ref://src/cart.ts",
			"ref://./src/cart.ts#add",
		]);
	});

	it("collects every refusal before refusing, one line per ref", async () => {
		const { refs } = scanRefs("[a](ref://src/nope.ts:X) and [b](ref://src/cart.ts#missing)");

		const outcome = await resolveRefs(refs, { workspace, session: unopened, load: loadRefFile, deadline: 0 });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.split("\n")).toEqual([
			expect.stringContaining("src/nope.ts does not exist"),
			expect.stringContaining('no match for "missing"'),
		]);
	});
});
