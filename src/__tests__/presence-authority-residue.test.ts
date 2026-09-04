import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

/**
 * A source-residue guard for how the console reads a session's presence.
 *
 * A session's facts reach the phone by TWO channels with very different latency: the presence plane
 * PUSHES the route Gateway's own rows on every poll, while every other machine's rows are PULLED
 * once per discovery interval. Nothing on the wire says which one delivered a row, so a consumer
 * that reads a value alone silently assumes push latency and is wrong for every machine but one.
 * That produced a blank terminal when waking a session on another machine, a composer notice that
 * fired on the wrong sessions, and a dozen display sites quietly showing another machine's state
 * from thirty seconds ago.
 *
 * The guarantee is STRUCTURAL first: the status string is private to `Presence`, whose constructor
 * is private, so a caller cannot re-derive `== "available"` and inherit the assumption. This test is
 * the backstop that keeps it that way, and it is in the TS suite ON PURPOSE - the Android tests run
 * on push to main, so a Kotlin-side assertion could not stop the regression from landing in a PR.
 *
 * Every check below has a positive control. A sweep that matches nothing must FAIL rather than look
 * clean, which is the difference between this and a tripwire.
 */
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

const ANDROID_SRC = path.join(
	REPO_ROOT,
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
);

const OWNER = path.join(ANDROID_SRC, "Presence.kt");

/** Files that must exist for any of this to mean anything. */
const ANCHORS = [OWNER, path.join(ANDROID_SRC, "Team.kt"), path.join(ANDROID_SRC, "TerminalView.kt")];

/** The wire's session-status vocabulary. Comparing against one of these outside the owner is the
 * exact shape of the original defect: a value read with no way to ask how old it is. */
const STATUS_LITERALS = ["online", "verifying", "available"];

function kotlinFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		// proto/ is generated from the shared schemas and carries the wire shape itself, which is
		// where these strings legitimately live.
		if (entry.isDirectory()) {
			if (entry.name !== "proto") out.push(...kotlinFiles(full));
		} else if (entry.name.endsWith(".kt")) {
			out.push(full);
		}
	}
	return out;
}

/** Source with comments and their contents removed, so prose ABOUT the rule is not mistaken for the
 * rule being broken - this file's own subject matter is discussed at length in those comments. */
function code(file: string): string {
	return fs
		.readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");
}

////////////////////////////////
//  Tests

describe("presence authority: the status string has one owner", () => {
	it("has a source tree to sweep", () => {
		// Vacuity guard: an empty sweep must fail rather than pass silently.
		for (const anchor of ANCHORS) expect(fs.existsSync(anchor), anchor).toBe(true);
		expect(kotlinFiles(ANDROID_SRC).length).toBeGreaterThan(50);
	});

	it("keeps Presence's constructor private, so there is one construction path", () => {
		const owner = fs.readFileSync(OWNER, "utf8");
		expect(owner).toMatch(/class Presence\s*\nprivate constructor\(/);
		// The status string itself, which is what a consumer must not be able to reach.
		expect(owner).toMatch(/private val status: String/);
		// The two named factories every caller goes through.
		expect(owner).toMatch(/fun reported\(/);
		expect(owner).toMatch(/fun ended\(/);
	});

	it("carries the authority that qualifies every answer", () => {
		const owner = fs.readFileSync(OWNER, "utf8");
		for (const a of ["LIVE", "POLLED", "UNREACHABLE", "NONE"]) expect(owner).toContain(a);
		// The two decisions the terminal's gate is built from. Losing either silently restores the
		// blank-terminal bug, since both would fall back to reading a bare status.
		expect(owner).toMatch(/fun mayHavePane\(/);
		expect(owner).toMatch(/val gatewayReachable:/);
	});

	it("keeps the presence fields off Team, where a caller could read them unqualified", () => {
		const team = code(path.join(ANDROID_SRC, "Team.kt"));
		expect(team).toMatch(/val presence: Presence/);
		for (const field of ["status", "working", "needsLogin", "limitBlocked", "limitDetail"]) {
			expect(team, `Team must not declare its own ${field}`).not.toMatch(
				new RegExp(`val\\s+${field}\\s*:\\s*(String|Boolean)`),
			);
		}
	});

	it("constructs a Presence nowhere but its own file", () => {
		const offenders = kotlinFiles(ANDROID_SRC)
			.filter((f) => f !== OWNER)
			.filter((f) => /\bPresence\(/.test(code(f)));
		expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
	});

	it("compares against a session-status literal nowhere but its own file", () => {
		// The residue proper. `== "available"` at a call site is the defect itself: a decision taken
		// on a value whose age the caller cannot see.
		const pattern = new RegExp(`[!=]=\\s*"(${STATUS_LITERALS.join("|")})"`);
		const offenders = kotlinFiles(ANDROID_SRC)
			.filter((f) => f !== OWNER)
			.filter((f) => pattern.test(code(f)));
		expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
	});

	it("still has consumers actually reading through the view", () => {
		// The other half of the vacuity guard: the checks above would all pass if the mechanism had
		// been deleted outright. These are the surfaces the original defect was found in, and each
		// must still be reading presence rather than something it re-derived.
		const consumers = [
			"SessionCard.kt",
			"TerminalView.kt",
			"MainActivity.kt",
			"ChatRepositorySend.kt",
			"ChatState.kt",
		];
		for (const name of consumers) {
			const src = code(path.join(ANDROID_SRC, name));
			// Comments are already stripped, so the bare identifier means real code reaches it.
			expect(src.includes("presence"), `${name} must read the presence view`).toBe(true);
		}
	});
});
