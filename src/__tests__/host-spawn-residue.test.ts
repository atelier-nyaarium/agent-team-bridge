// The `project === "host"` literal lived in four files that all had to agree, plus a fifth that
// held it as a VALUE. `host-spawn.ts` is the one owner now, and this fails the build if a new site
// re-derives the rule instead of asking. In the TS suite on purpose: it must block a PR, and the
// Kotlin tests only run after merge.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildHostLaunch,
	HOST_SPAWN,
	hostSpawnIds,
	isHostSpawn,
	MAX_LAUNCH_COMMAND_LEN,
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
		expect(isHostSpawn("nyaakube")).toBe(false);
		expect(isHostSpawn("")).toBe(false);
	});

	it("refuses an unregistered spawn point rather than building a command for it", () => {
		expect(() =>
			buildHostLaunch("windows", { composite: "windows.a1", claude: "claude", exportToken: "" }),
		).toThrow(/not a host spawn point/);
	});

	it("refuses an over-long command instead of handing it to tmux", () => {
		expect(() =>
			buildHostLaunch(HOST_SPAWN, {
				composite: "host.a1",
				claude: "claude",
				exportToken: "",
				workdir: `/${"x".repeat(MAX_LAUNCH_COMMAND_LEN)}`,
			}),
		).toThrow(/refusing to launch/);
	});
});
