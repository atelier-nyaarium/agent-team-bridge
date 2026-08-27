// The `project === "host"` literal lived in four files that all had to agree, plus a fifth that
// held it as a VALUE. `host-spawn.ts` is the one owner now, and this fails the build if a new site
// re-derives the rule instead of asking. In the TS suite on purpose: it must block a PR, and the
// Kotlin tests only run after merge.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildHostLaunch,
	encodePowerShellCommand,
	HOST_SPAWN,
	hostSpawnIds,
	isHostSpawn,
	isUncPath,
	MAX_LAUNCH_COMMAND_LEN,
	WINDOWS_SPAWN,
} from "../shared/host-spawn.js";

////////////////////////////////
//  Functions & Helpers

const SRC = path.join(import.meta.dirname, "..");
const OWNER = path.join("shared", "host-spawn.ts");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			out.push(...sourceFiles(full));
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

/** Comparing a spawn/project variable against the bare literal, in either order. */
const COMPARED_TO_HOST =
	/\b(?:project|spawn|spawnPoint|name)\s*(?:===|!==)\s*["']host["']|["']host["']\s*(?:===|!==)\s*\b(?:project|spawn)\b/;

////////////////////////////////
//  Tests

describe("host spawn residue", () => {
	// The sweep below reports "clean" by finding nothing, which is also what a broken scanner
	// reports. These are the files that HELD the literal before this refactor, so if the walk stops
	// reaching them the sweep has silently stopped proving anything.
	it("the scan actually reaches the files that used to hold the literal", () => {
		const scanned = new Set(sourceFiles(SRC).map((f) => path.relative(SRC, f)));
		for (const sentinel of [
			path.join("gateway", "wakeService.ts"),
			path.join("gateway", "console", "consoleTargets.ts"),
			path.join("gateway", "codexRoute.ts"),
			path.join("gateway", "copilotRoute.ts"),
			path.join("mcp", "devcontainer", "hostDaemon.ts"),
			path.join("mcp", "devcontainer", "hostResolve.ts"),
			path.join("mcp", "devcontainer", "tmuxCore.ts"),
		]) {
			expect(scanned).toContain(sentinel);
		}
	});

	// Scope, stated so it is not mistaken for a whole-repo guarantee: TypeScript under src/ only.
	// It cannot see Kotlin (android/), scripts/, or an indirect form where the literal reaches a
	// variable first. The console's own hardcoded "host" sites are real and live outside this net;
	// they are listed in plans/windows-spawn-point.md as part of registering `windows`.
	it('no TypeScript under src/ outside host-spawn.ts compares a spawn segment to the bare "host" literal', () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC)) {
			const rel = path.relative(SRC, file);
			if (rel === OWNER) continue;
			const body = fs.readFileSync(file, "utf8");
			if (COMPARED_TO_HOST.test(body)) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});

	// Positive controls: an empty sweep must be able to FAIL, or the test above passes vacuously
	// forever the moment the regex stops matching anything.
	it("the residue pattern actually matches the shapes it is meant to catch", () => {
		expect(COMPARED_TO_HOST.test('if (project === "host") {')).toBe(true);
		expect(COMPARED_TO_HOST.test("if (project !== 'host') {")).toBe(true);
		expect(COMPARED_TO_HOST.test('if ("host" === project) {')).toBe(true);
		expect(COMPARED_TO_HOST.test("if (isHostSpawn(project)) {")).toBe(false);
	});

	it("finds every registered spawn point and nothing else", () => {
		expect(hostSpawnIds()).toContain(HOST_SPAWN);
		expect(isHostSpawn(HOST_SPAWN)).toBe(true);
		expect(isHostSpawn(WINDOWS_SPAWN)).toBe(true);
		expect(isHostSpawn("nyaakube")).toBe(false);
		expect(isHostSpawn("")).toBe(false);
	});

	it("refuses an unregistered spawn point rather than building a command for it", () => {
		expect(() =>
			buildHostLaunch("plan9", { composite: "plan9.a1", claudeArgs: "--model opus", exportToken: "" }),
		).toThrow(/not a host spawn point/);
	});

	it("refuses an over-long command instead of handing it to tmux", () => {
		expect(() =>
			buildHostLaunch(HOST_SPAWN, {
				composite: "host.a1",
				claudeArgs: "--model opus",
				exportToken: "",
				workdir: `/${"x".repeat(MAX_LAUNCH_COMMAND_LEN)}`,
			}),
		).toThrow(/refusing to launch/);
	});
});

// Each assertion here pins a fact MEASURED on a WSL box, not a preference. The comments name what
// breaks if it changes, because every one of these was a way to ship a session that dies at launch.
describe("windows spawn point", () => {
	const ctx = (over: Partial<Parameters<typeof buildHostLaunch>[1]> = {}) => ({
		composite: "windows.a1",
		claudeArgs: "--model opus --effort xhigh",
		exportToken: "",
		workdir: "C:\\Users\\me\\project",
		...over,
	});

	// Bare `claude` and `claude.cmd` do NOT resolve from Windows PowerShell; only the .exe does.
	it("invokes claude.exe, not claude", () => {
		const script = decode(buildHostLaunch(WINDOWS_SPAWN, ctx()));
		expect(script).toContain("claude.exe --model opus --effort xhigh");
		expect(script).not.toMatch(/(?:^|[^.])\bclaude --/);
	});

	// The pane inherits WSL's cwd, which lands PowerShell on a \\wsl.localhost UNC provider path.
	// A legacy console app started from there can silently get C:\Windows instead.
	it("always sets its location rather than inheriting the pane's", () => {
		expect(decode(buildHostLaunch(WINDOWS_SPAWN, ctx()))).toContain(
			"Set-Location -LiteralPath 'C:\\Users\\me\\project'",
		);
	});

	// A context with no workdir means the daemon failed to resolve one. Guessing a default here would
	// put the session in the wrong tree; the daemon owns that answer and has a Windows-side default.
	it("refuses to launch without a resolved working directory", () => {
		expect(() => buildHostLaunch(WINDOWS_SPAWN, ctx({ workdir: undefined }))).toThrow(/working directory/);
	});

	// An exported variable does not reach a Win32 child on its own; WSL passes only what WSLENV names.
	// Without this the agent registers under a derived name and cannot claim its binding.
	it("crosses both identity variables through WSLENV, appending rather than assigning", () => {
		const withToken = buildHostLaunch(
			WINDOWS_SPAWN,
			ctx({ exportToken: "export SWITCHBOARD_SESSION_TOKEN=abc; " }),
		);
		expect(withToken).toContain("PROJECT_NAME/w:SWITCHBOARD_SESSION_TOKEN/w");
		// ${WSLENV:+$WSLENV:} keeps whatever the environment was already propagating.
		expect(withToken).toContain('export WSLENV="${WSLENV:+$WSLENV:}');
		// No token, no token entry: naming a variable that does not exist is not free.
		expect(buildHostLaunch(WINDOWS_SPAWN, ctx())).not.toContain("SWITCHBOARD_SESSION_TOKEN");
	});

	// -NoExit is the twin of `exec bash`: it is what keeps the pane alive and peekable after the
	// agent exits, which reattach and the console terminal view both depend on.
	it("keeps the pane alive after the agent exits", () => {
		expect(buildHostLaunch(WINDOWS_SPAWN, ctx())).toContain("-NoExit");
	});

	// Base64 has no shell metacharacter, so nesting through tmux, bash -c, powershell argv and the
	// PowerShell parser cannot be broken out of. That is why the whole class is inexpressible here.
	it("carries the script as base64 of UTF-16LE, with no quote reaching the shell nesting", () => {
		const command = buildHostLaunch(WINDOWS_SPAWN, ctx());
		const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)'$/.exec(command)?.[1];
		expect(encoded).toBeTruthy();
		expect(Buffer.from(encoded!, "base64").toString("utf16le")).toContain("Set-Location");
	});

	it("encodePowerShellCommand is UTF-16LE, which is what -EncodedCommand requires", () => {
		// "A" is 0x41 0x00 in UTF-16LE. A UTF-8 encoding would be a single byte and silently wrong.
		expect(Buffer.from(encodePowerShellCommand("A"), "base64").toString("hex")).toBe("4100");
	});

	it("isUncPath recognises the shape wslpath returns for a Linux path", () => {
		expect(isUncPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me")).toBe(true);
		expect(isUncPath("C:\\Users\\me")).toBe(false);
	});
});

/** The PowerShell script a built command carries, back out of its base64. */
function decode(command: string): string {
	const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)'$/.exec(command)?.[1];
	if (!encoded) throw new Error(`no encoded command in: ${command}`);
	return Buffer.from(encoded, "base64").toString("utf16le");
}
