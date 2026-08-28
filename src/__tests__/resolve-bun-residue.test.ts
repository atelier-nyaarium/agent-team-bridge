// Launchers must get bun from scripts/resolve-bun.sh, not from PATH.
//
// Typing `bun` finds it. Cron gets a shell where it is missing. That gap is how the Router silently
// failed to start at boot while the gateway came up fine.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

const ROOT = path.join(import.meta.dirname, "..", "..");
const OWNER = path.join("scripts", "resolve-bun.sh");

/** Launchers sit at the repo root. The resolver is the one under scripts/. */
function shellScripts(): string[] {
	const root = fs.readdirSync(ROOT).filter((name) => name.endsWith(".sh"));
	return [...root, OWNER];
}

/** A bare `bun` call. Anything quoted or carrying a path is already resolved. */
const BARE_BUN_CALL = /(?:^|[;&|]\s*|\bexec\s+|\$\(\s*)bun\s+(?:run|x|--)/m;

////////////////////////////////
//  Tests

describe("bun resolution", () => {
	it("the scan reaches the launchers that exec bun", () => {
		const scanned = new Set(shellScripts());
		for (const name of ["start-federation.sh", "setup.sh", "run-host-daemon.sh"]) {
			expect(scanned).toContain(name);
		}
	});

	it("no launcher invokes bun by bare name", () => {
		const offenders = shellScripts().filter((rel) =>
			BARE_BUN_CALL.test(fs.readFileSync(path.join(ROOT, rel), "utf8")),
		);
		expect(offenders).toEqual([]);
	});

	it("every launcher that execs bun sources the owner", () => {
		const users = shellScripts().filter(
			(rel) => rel !== OWNER && /\$BUN"?\s+run/.test(fs.readFileSync(path.join(ROOT, rel), "utf8")),
		);
		expect(users.length).toBeGreaterThan(0);
		for (const rel of users) {
			expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toContain("resolve-bun.sh");
		}
	});

	// Without these, the sweep quietly passes if the pattern ever stops matching.
	it("the pattern matches a bare call and not a resolved one", () => {
		expect(BARE_BUN_CALL.test("exec bun run scripts/setup.ts")).toBe(true);
		expect(BARE_BUN_CALL.test("bun run build patch")).toBe(true);
		expect(BARE_BUN_CALL.test('exec "$BUN" run scripts/setup.ts')).toBe(false);
		expect(BARE_BUN_CALL.test('echo "bun not found"')).toBe(false);
	});
});
