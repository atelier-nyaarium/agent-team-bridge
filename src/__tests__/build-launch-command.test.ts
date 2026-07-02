import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLaunchCommand, resolveHostWorkdir } from "../mcp/devcontainer/hostDaemon.js";

const dc = { kind: "devcontainer" as const, name: "recipe-app", sessionName: "scratch" };

describe("buildLaunchCommand", () => {
	it("overrides PROJECT_NAME to the composite, cds to the workspace, and execs claude (no resume)", () => {
		const cmd = buildLaunchCommand(dc);
		expect(cmd).toContain("export PROJECT_NAME=recipe-app.scratch");
		expect(cmd).toContain("cd /workspace/recipe-app");
		expect(cmd).toContain("exec claude");
		expect(cmd).not.toContain("--resume");
		// The override runs after sourcing bashrc so it wins over the image ENV.
		expect(cmd.indexOf("source ~/.bashrc")).toBeLessThan(cmd.indexOf("export PROJECT_NAME"));
	});

	it("appends --resume for a uuid-shaped session id", () => {
		const cmd = buildLaunchCommand(dc, { resumeSessionId: "12345678-1234-1234-1234-123456789abc" });
		expect(cmd).toContain("--resume 12345678-1234-1234-1234-123456789abc");
	});

	it("ignores a malformed resume id (no --resume injected)", () => {
		const cmd = buildLaunchCommand(dc, { resumeSessionId: "x'; rm -rf /" });
		expect(cmd).not.toContain("--resume");
	});

	it("keeps a host session's pane alive with exec bash and does not cd into a workspace", () => {
		const cmd = buildLaunchCommand({ kind: "host", name: "host", sessionName: "foo" });
		expect(cmd).toContain("export PROJECT_NAME=host.foo");
		expect(cmd).toContain("; exec bash");
		expect(cmd).not.toContain("cd /workspace");
		expect(cmd).not.toContain('cd "');
	});

	it("cds a host session to its resolved workdir and resumes by id", () => {
		const cmd = buildLaunchCommand(
			{ kind: "host", name: "host", sessionName: "nyaadot" },
			{ workdir: "/home/nyaarium/projects/nyaadot", resumeSessionId: "12345678-1234-1234-1234-123456789abc" },
		);
		expect(cmd).toContain('cd "/home/nyaarium/projects/nyaadot"');
		expect(cmd).toContain("--resume 12345678-1234-1234-1234-123456789abc");
		expect(cmd).toContain("; exec bash");
		expect(cmd).not.toContain("cd /workspace");
	});

	it("drops the cd when the workdir holds a single quote that would break the outer bash -c", () => {
		const cmd = buildLaunchCommand(
			{ kind: "host", name: "host", sessionName: "foo" },
			{ workdir: "/home/it's/projects/foo" },
		);
		expect(cmd).not.toContain('cd "');
		expect(cmd).not.toContain("it's");
	});

	it("drops the cd when the workdir holds a double quote that would break the cd's own quoting", () => {
		const cmd = buildLaunchCommand(
			{ kind: "host", name: "host", sessionName: "foo" },
			{ workdir: '/home/projects/a"; rm -rf ~ #' },
		);
		expect(cmd).not.toContain('cd "');
		expect(cmd).not.toContain("rm -rf");
	});
});

describe("resolveHostWorkdir", () => {
	it("picks the first projectDir/<hint> that exists, else home", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		fs.mkdirSync(path.join(base, "myproj"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		expect(resolveHostWorkdir("myproj", [base], home)).toBe(path.join(base, "myproj"));
		expect(resolveHostWorkdir("absent", [base], home)).toBe(home);
	});

	it("falls back to home for a missing hint or one that is not a single path segment", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		fs.mkdirSync(path.join(base, "myproj"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		expect(resolveHostWorkdir(undefined, [base], home)).toBe(home);
		expect(resolveHostWorkdir("", [base], home)).toBe(home);
		expect(resolveHostWorkdir(".", [base], home)).toBe(home);
		expect(resolveHostWorkdir("..", [base], home)).toBe(home);
		expect(resolveHostWorkdir("../myproj", [base], home)).toBe(home);
		expect(resolveHostWorkdir("sub/dir", [base], home)).toBe(home);
	});
});
