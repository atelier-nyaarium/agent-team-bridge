import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyPath, resetWorkspaceRoot, workspaceRoot } from "../mcp/references/refWorkspace.js";

////////////////////////////////
//  Functions & Helpers

let root: string;
let priorRoot: string | undefined;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ref-workspace-"));
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	priorRoot = process.env.REFERENCE_ROOT;
	resetWorkspaceRoot();
});

afterEach(() => {
	if (priorRoot === undefined) delete process.env.REFERENCE_ROOT;
	else process.env.REFERENCE_ROOT = priorRoot;
	resetWorkspaceRoot();
	fs.rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the workspace root", () => {
	it("takes REFERENCE_ROOT and holds it until reset", () => {
		process.env.REFERENCE_ROOT = root;
		expect(workspaceRoot()).toEqual({ root, admitted: true });

		process.env.REFERENCE_ROOT = path.join(root, "src");
		expect(workspaceRoot().root).toBe(root);
		resetWorkspaceRoot();
		expect(workspaceRoot().root).toBe(path.join(root, "src"));
	});

	it("knows before any spawn that the daemon would refuse the filesystem root", () => {
		process.env.REFERENCE_ROOT = path.parse(root).root;
		const judged = workspaceRoot();
		expect(judged.admitted).toBe(false);
		expect(!judged.admitted && judged.reason).toContain("filesystem root");
	});
});

describe("where a written path lands", () => {
	it("keys a bare path under the root as the module the index lists", () => {
		expect(classifyPath(root, "src/app.ts")).toEqual({
			kind: "module",
			absolute: path.join(root, "src", "app.ts"),
			module: "src/app.ts",
		});
		expect(classifyPath(root, "./src/../src/app.ts")).toMatchObject({ kind: "module", module: "src/app.ts" });
		expect(classifyPath(root, "src\\app.ts")).toMatchObject({ kind: "module", module: "src/app.ts" });
	});

	it("calls a path that walks out, an absolute path elsewhere, and a home path outside", () => {
		expect(classifyPath(root, "../elsewhere/notes.txt")).toMatchObject({ kind: "outside" });
		expect(classifyPath(root, "src/../../notes.txt")).toMatchObject({ kind: "outside" });
		expect(classifyPath(root, "/etc/hosts")).toEqual({ kind: "outside", absolute: "/etc/hosts" });
		expect(classifyPath(root, "~/notes.txt")).toEqual({
			kind: "outside",
			absolute: path.join(os.homedir(), "notes.txt"),
		});
		expect(classifyPath(root, "")).toMatchObject({ kind: "outside" });
	});

	it("keeps ~user literal and inside the root", () => {
		expect(classifyPath(root, "~someone/notes.txt")).toMatchObject({
			kind: "module",
			module: "~someone/notes.txt",
		});
	});

	it("keys a decomposed name under its composed form, as the index does", () => {
		const decomposed = `src/café.ts`;
		expect(classifyPath(root, decomposed)).toMatchObject({ kind: "module", module: "src/café.ts" });
	});

	it("does not follow a link inside the root, so a tracked alias stays the index's module", () => {
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ref-elsewhere-"));
		try {
			fs.writeFileSync(path.join(elsewhere, "notes.txt"), "outside\n");
			fs.symlinkSync(path.join(elsewhere, "notes.txt"), path.join(root, "src", "alias.txt"));
			expect(classifyPath(root, "src/alias.txt")).toMatchObject({ kind: "module", module: "src/alias.txt" });
		} finally {
			fs.rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});
