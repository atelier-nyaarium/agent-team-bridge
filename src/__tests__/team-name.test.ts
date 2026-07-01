import { describe, expect, it } from "vitest";
import { resolveSessionNaming, stableTeamName } from "../mcp/team-name.js";

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

// adhoc is the durability gate: an ad-hoc register omits its resume id, so a wrong classification
// either strands phantom "available" cards (under-suppress) or strips resume from daemon sessions
// (over-suppress). Pin every provenance case.
describe("resolveSessionNaming", () => {
	it("unset PROJECT_NAME composes host.<stable-hex> and is ad-hoc", () => {
		const r = resolveSessionNaming(undefined, SID_A);
		expect(r.projectName).toBe(`host.${stableTeamName(SID_A)}`);
		expect(r.adhoc).toBe(true);
	});

	it("empty PROJECT_NAME behaves as unset (ad-hoc under host)", () => {
		const r = resolveSessionNaming("", SID_A);
		expect(r.projectName).toBe(`host.${stableTeamName(SID_A)}`);
		expect(r.adhoc).toBe(true);
	});

	it("a bare image-ENV name is normalized to a session under that spawn and is ad-hoc", () => {
		const r = resolveSessionNaming("evie-bot", SID_A);
		expect(r.projectName).toBe(`evie-bot.${stableTeamName(SID_A)}`);
		expect(r.adhoc).toBe(true);
	});

	it("a daemon-composed composite passes through untouched and stays durable", () => {
		const r = resolveSessionNaming("host.nyaadot", SID_A);
		expect(r).toEqual({ projectName: "host.nyaadot", adhoc: false });
	});

	it("an explicitly hand-set composite is durable (the escape hatch for a named terminal session)", () => {
		const r = resolveSessionNaming("host.mywork", undefined);
		expect(r).toEqual({ projectName: "host.mywork", adhoc: false });
	});

	it("no harness session id falls back to a random name, still ad-hoc", () => {
		const r = resolveSessionNaming(undefined, undefined);
		expect(r.projectName).toMatch(/^host\.[0-9a-f]{6}$/);
		expect(r.adhoc).toBe(true);
	});
});
