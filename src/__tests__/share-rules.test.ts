import { describe, expect, it } from "vitest";
import { isSharedTo, share, sweep } from "../shared/share-rules.js";

const target = { kind: "domain" as const, domainId: "friend" };

describe("share rules", () => {
	it("shares and detects a link", () => {
		const state = share({ shares: [] }, "session", target, 10);
		expect(isSharedTo(state, "session", "friend", () => true)).toBe(true);
	});

	it("does not detect an absent link", () => {
		const state = share({ shares: [] }, "session", { kind: "everyone_trusted" }, 10);
		expect(isSharedTo(state, "session", "friend", () => false)).toBe(false);
	});

	it("sweeps stale shares and keeps a live one", () => {
		const state = {
			shares: [
				{ sessionTarget: "stale", target, lastSeenAt: 0 },
				{ sessionTarget: "live", target, lastSeenAt: 0 },
			],
		};
		const result = sweep(state, 100, 10, (sessionTarget) => sessionTarget === "live");
		expect(result.removed).toBe(1);
		expect(result.state.shares.map((s) => s.sessionTarget)).toEqual(["live"]);
	});
});
