import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyPath,
	expectHostRoots,
	hostRootsSettled,
	resetWorkspaceRoot,
	setHostRoots,
	startDirectory,
	workspaceRoot,
} from "../mcp/references/refWorkspace.js";

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

describe("the host's roots", () => {
	it("takes the host's first file root over the cwd, up to its git toplevel", () => {
		delete process.env.REFERENCE_ROOT;
		execFileSync("git", ["init", "-q", root]);
		setHostRoots([pathToFileURL(path.join(root, "src")).href]);
		expect(workspaceRoot().root).toBe(fs.realpathSync.native(root));
	});

	it("stays on the host's root when it is not a git tree, and decodes the URI", () => {
		delete process.env.REFERENCE_ROOT;
		const spaced = path.join(root, "my ws");
		fs.mkdirSync(spaced);
		setHostRoots([pathToFileURL(spaced).href, pathToFileURL(root).href]);
		expect(workspaceRoot().root).toBe(spaced);
	});

	it("ignores roots that are not file URIs and reads the cwd when none is left", () => {
		delete process.env.REFERENCE_ROOT;
		const fromCwd = workspaceRoot().root;
		setHostRoots(["https://example.test/repo", "not a uri"]);
		expect(workspaceRoot().root).toBe(fromCwd);
	});

	it("yields to REFERENCE_ROOT", () => {
		process.env.REFERENCE_ROOT = path.join(root, "src");
		setHostRoots([pathToFileURL(root).href]);
		expect(workspaceRoot().root).toBe(path.join(root, "src"));
	});

	it("holds a reply until the host has answered, and a reset releases it", async () => {
		let answered = false;
		expectHostRoots();
		const waited = hostRootsSettled().then(() => {
			answered = true;
		});
		await Promise.resolve();
		expect(answered).toBe(false);
		setHostRoots([pathToFileURL(root).href]);
		await waited;
		expect(workspaceRoot().root).toBe(root);

		expectHostRoots();
		resetWorkspaceRoot();
		await hostRootsSettled();
	});
});

describe("the start directory when the host names no root", () => {
	it("reads the shell's PWD when the server was started inside its own plugin checkout", () => {
		const plugin = path.join(root, "plugin");
		const project = path.join(root, "project");
		fs.mkdirSync(path.join(plugin, "dist"), { recursive: true });
		fs.mkdirSync(project);
		expect(startDirectory(plugin, project, plugin)).toBe(project);
		expect(startDirectory(path.join(plugin, "dist"), project, plugin)).toBe(project);

		const link = path.join(root, "plugin-link");
		fs.symlinkSync(plugin, link);
		expect(startDirectory(path.join(plugin, "dist"), project, link)).toBe(project);
	});

	it("reads PWD, else home, when the directory the server started in is gone", () => {
		const project = path.join(root, "project");
		fs.mkdirSync(project);
		expect(startDirectory(null, project, path.join(root, "plugin"))).toBe(project);
		expect(startDirectory(null, path.join(root, "missing"), path.join(root, "plugin"))).toBe(os.homedir());
		expect(startDirectory(null, undefined, path.join(root, "plugin"))).toBe(os.homedir());
	});

	it("keeps the cwd when it is a project, when PWD is unset, the same, or not a directory", () => {
		const plugin = path.join(root, "plugin");
		const project = path.join(root, "project");
		fs.mkdirSync(plugin);
		fs.mkdirSync(project);
		fs.writeFileSync(path.join(root, "file.txt"), "x\n");
		expect(startDirectory(project, plugin, plugin)).toBe(project);
		expect(startDirectory(plugin, undefined, plugin)).toBe(plugin);
		expect(startDirectory(plugin, plugin, plugin)).toBe(plugin);
		expect(startDirectory(plugin, path.join(root, "file.txt"), plugin)).toBe(plugin);
		expect(startDirectory(plugin, path.join(root, "missing"), plugin)).toBe(plugin);
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
