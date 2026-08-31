import { describe, expect, it } from "vitest";
import { resolveSessionNaming, stableTeamName } from "../mcp/team-name.js";
import { isValidSessionName } from "../shared/session-id.js";

const SID_A = "c44a37c4-501a-4db0-871c-90e927014163";
const SID_B = "78520221-0000-0000-0000-000000000000";

describe("stableTeamName", () => {
	it("derives a deterministic 6-hex name from a session id (stable across reload / resume)", () => {
		const a = stableTeamName(SID_A);
		expect(a).toBe(stableTeamName(SID_A));
		expect(a).toMatch(/^[0-9a-f]{6}$/);
	});

	it("derives different names for different session ids", () => {
		expect(stableTeamName(SID_A)).not.toBe(stableTeamName(SID_B));
	});

	it("returns null when the session id is absent (older harness / print-throwaway)", () => {
		expect(stableTeamName(undefined)).toBeNull();
		expect(stableTeamName("")).toBeNull();
	});

	it("never produces a reserved team name (hex output is disjoint from gateway/host)", () => {
		const reserved = new Set(["gateway", "host"]);
		for (const sid of ["a", "gateway", "host", SID_A, SID_B]) {
			const name = stableTeamName(sid);
			expect(name).toMatch(/^[0-9a-f]{6}$/);
			expect(reserved.has(name as string)).toBe(false);
		}
	});
});

// Every live registrant must be a composite `spawn.session`; a bare arity-1 name is reserved for a
// catalog spawn-point. Pin each normalization branch.
describe("resolveSessionNaming", () => {
	it("recognizes only canonical composite slug names", () => {
		expect(isValidSessionName("recipe-app.scratch")).toBe(true);
		expect(isValidSessionName("Recipe.scratch")).toBe(false);
		expect(isValidSessionName("recipe.app.scratch")).toBe(false);
	});

	it("unset PROJECT_NAME composes host.<stable-hex>", () => {
		expect(resolveSessionNaming(undefined, SID_A)).toBe(`host.${stableTeamName(SID_A)}`);
	});

	it("empty PROJECT_NAME behaves as unset (under host)", () => {
		expect(resolveSessionNaming("", SID_A)).toBe(`host.${stableTeamName(SID_A)}`);
	});

	it("a bare image-ENV name is normalized to a session under that spawn", () => {
		expect(resolveSessionNaming("evie-bot", SID_A)).toBe(`evie-bot.${stableTeamName(SID_A)}`);
	});

	it("a daemon-composed composite passes through untouched", () => {
		expect(resolveSessionNaming("host.nyaadot", SID_A)).toBe("host.nyaadot");
	});

	it("an explicitly hand-set composite passes through (the escape hatch for a named terminal session)", () => {
		expect(resolveSessionNaming("host.mywork", undefined)).toBe("host.mywork");
	});

	it("no harness session id falls back to a random name", () => {
		expect(resolveSessionNaming(undefined, undefined)).toMatch(/^host\.[0-9a-f]{6}$/);
	});
});
