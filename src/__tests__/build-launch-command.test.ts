import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildLaunchCommand,
	listHostDirs,
	resolveHostWorkdir,
	resolveWatchTarget,
	shouldGreetLaunch,
} from "../mcp/devcontainer/hostResolve.js";

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

	it("puts the daemon's bin dir ahead of PATH after bashrc and before the identity exports", () => {
		const cmd = buildLaunchCommand(
			{ kind: "host", name: "host", sessionName: "foo" },
			{ pathPrefix: "/home/me/.bun/bin", sessionToken: "0123456789abcdef" },
		);
		expect(cmd).toContain('export PATH="/home/me/.bun/bin:$PATH"; ');
		expect(cmd.indexOf("source ~/.bashrc")).toBeLessThan(cmd.indexOf("export PATH="));
		expect(cmd.indexOf("export PATH=")).toBeLessThan(cmd.indexOf("export PROJECT_NAME"));
	});

	it("drops a PATH prefix that is not a plain absolute path, and never applies one to a devcontainer", () => {
		const host = { kind: "host" as const, name: "host", sessionName: "foo" };
		expect(buildLaunchCommand(host, { pathPrefix: "/home/it's/bin" })).not.toContain("export PATH=");
		expect(buildLaunchCommand(host, { pathPrefix: "/x; rm -rf ~" })).not.toContain("export PATH=");
		expect(buildLaunchCommand(host, { pathPrefix: "relative/bin" })).not.toContain("export PATH=");
		expect(buildLaunchCommand(dc, { pathPrefix: "/home/me/.bun/bin" })).not.toContain("export PATH=");
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

	it("uses a picked absolute path verbatim when it is a real directory, else home", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		const real = path.join(base, "some", "deep", "dir");
		fs.mkdirSync(real, { recursive: true });
		expect(resolveHostWorkdir(real, [base], home)).toBe(real);
		expect(resolveHostWorkdir(path.join(base, "gone"), [base], home)).toBe(home);
	});

	it("expands a ~-rooted picked path against home; bare ~ is home itself", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		fs.mkdirSync(path.join(home, "Downloads"));
		expect(resolveHostWorkdir("~/Downloads", [base], home)).toBe(path.join(home, "Downloads"));
		expect(resolveHostWorkdir("~", [base], home)).toBe(home);
		expect(resolveHostWorkdir("~/absent", [base], home)).toBe(home);
	});

	it("drops a picked path bearing a launch-breakout character to home, even if the dir exists", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		const quoted = path.join(base, "it's");
		fs.mkdirSync(quoted);
		expect(resolveHostWorkdir(quoted, [base], home)).toBe(home);
		expect(resolveHostWorkdir(`${base}/a\`b`, [base], home)).toBe(home);
		expect(resolveHostWorkdir(`${base}/a$b`, [base], home)).toBe(home);
	});
});

describe("listHostDirs", () => {
	it("lists immediate subdirectories only (no files), sorted case-insensitively", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lshome-"));
		fs.mkdirSync(path.join(home, "beta"));
		fs.mkdirSync(path.join(home, "Alpha"));
		fs.writeFileSync(path.join(home, "notes.txt"), "x");
		expect(listHostDirs(home, home)).toEqual({ entries: ["Alpha", "beta"] });
	});

	it("expands ~/ against home and includes dot dirs (the console handles their placement)", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lshome-"));
		fs.mkdirSync(path.join(home, "sub"));
		fs.mkdirSync(path.join(home, "sub", ".config"));
		fs.mkdirSync(path.join(home, "sub", "projects"));
		expect(listHostDirs("~/sub", home)).toEqual({ entries: [".config", "projects"] });
	});

	it("follows a symlink to a directory but skips one to a file", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lshome-"));
		fs.mkdirSync(path.join(home, "real"));
		fs.writeFileSync(path.join(home, "file.txt"), "x");
		fs.symlinkSync(path.join(home, "real"), path.join(home, "dirlink"));
		fs.symlinkSync(path.join(home, "file.txt"), path.join(home, "filelink"));
		fs.symlinkSync(path.join(home, "nowhere"), path.join(home, "dangling"));
		expect(listHostDirs(home, home)).toEqual({ entries: ["dirlink", "real"] });
	});

	it("returns empty for a missing path or a non-path shape rather than erroring", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lshome-"));
		expect(listHostDirs(path.join(home, "gone"), home)).toEqual({ entries: [] });
		expect(listHostDirs("not-a-path", home)).toEqual({ entries: [] });
	});
});

describe("resolveWatchTarget", () => {
	it("resolves a devcontainer composite to a docker-exec target", () => {
		expect(resolveWatchTarget("recipe-app.scratch")).toEqual({
			kind: "devcontainer",
			name: "recipe-app",
			sessionName: "scratch",
		});
	});

	it("resolves a host composite to the bare-tmux target", () => {
		expect(resolveWatchTarget("host.nyaadot")).toEqual({ kind: "host", name: "host", sessionName: "nyaadot" });
	});

	it("refuses the daemon's own reserved supervisor session", () => {
		expect(resolveWatchTarget("host.host-daemon")).toBeUndefined();
	});

	it("refuses a malformed (non-slug) project or session segment", () => {
		expect(resolveWatchTarget("Recipe App.scratch")).toBeUndefined();
		expect(resolveWatchTarget("recipe-app.$(rm -rf)")).toBeUndefined();
	});
});

describe("shouldGreetLaunch", () => {
	it("greets a first-time create", () => {
		expect(shouldGreetLaunch({ created: true, ready: true })).toBe(true);
	});

	it("skips a reattach", () => {
		expect(shouldGreetLaunch({ created: false, ready: true })).toBe(false);
	});

	it("skips a wake resuming a transcript", () => {
		expect(
			shouldGreetLaunch({ created: true, ready: true, resumeSessionId: "12345678-1234-1234-1234-123456789abc" }),
		).toBe(false);
	});

	it("skips a pane with no composer", () => {
		expect(shouldGreetLaunch({ created: true, ready: false })).toBe(false);
	});
});
