import { describe, expect, it } from "vitest";
import { stableTeamName } from "../mcp/team-name.js";

const SID_A = "c44a37c4-501a-4db0-871c-90e927014163";
const SID_B = "78520221-0000-0000-0000-000000000000";

describe("stableTeamName", () => {
	it("derives a deterministic 6-hex name from a session id (stable across reload / resume)", () => {
		const a = stableTeamName(SID_A, false);
		expect(a).toBe(stableTeamName(SID_A, false));
		expect(a).toMatch(/^[0-9a-f]{6}$/);
	});

	it("derives different names for different session ids", () => {
		expect(stableTeamName(SID_A, false)).not.toBe(stableTeamName(SID_B, false));
	});

	it("returns null for a subagent so it falls back to its own random name", () => {
		// A subagent inherits the parent's session id; returning null avoids colliding on the
		// parent's team name (and receiving the parent's phone pushes).
		expect(stableTeamName(SID_A, true)).toBeNull();
	});

	it("returns null when the session id is absent (older harness / print-throwaway)", () => {
		expect(stableTeamName(undefined, false)).toBeNull();
		expect(stableTeamName("", false)).toBeNull();
	});

	it("never produces a reserved team name (hex output is disjoint from gateway/host)", () => {
		const reserved = new Set(["gateway", "host"]);
		for (const sid of ["a", "gateway", "host", SID_A, SID_B]) {
			const name = stableTeamName(sid, false);
			expect(name).toMatch(/^[0-9a-f]{6}$/);
			expect(reserved.has(name as string)).toBe(false);
		}
	});
});
