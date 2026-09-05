import { describe, expect, it } from "vitest";
import {
	dropDomain,
	isSharedTo,
	type ShareState,
	share,
	sharesFor,
	sweep,
	targetKey,
	touch,
	unshare,
} from "../shared/share-rules.js";

const domain = (domainId: string) => ({ kind: "domain" as const, domainId });

describe("share rules", () => {
	it("keys, shares, refreshes, and unshares targets", () => {
		let state: ShareState = { shares: [] };
		state = share(state, "session", domain("friend"), 10);
		state = share(state, "session", domain("friend"), 20);
		expect(targetKey(domain("friend"))).toBe("domain:friend");
		expect(state.shares).toEqual([{ sessionTarget: "session", target: domain("friend"), lastSeenAt: 20 }]);
		expect(isSharedTo(touch(state, "session", 30), "session", "friend", () => true)).toBe(true);
		expect(unshare(state, "session", domain("friend"))).toEqual({ state: { shares: [] }, removed: true });
	});

	it("gates trusted shares, drops domains, and deduplicates session targets", () => {
		let state: ShareState = { shares: [] };
		state = share(state, "friend-session", { kind: "everyone_trusted" }, 1);
		state = share(state, "friend-session", domain("friend"), 2);
		state = share(state, "other", domain("other"), 3);
		expect(isSharedTo(state, "friend-session", "friend", (id) => id === "friend")).toBe(true);
		expect(isSharedTo(state, "friend-session", "other", () => false)).toBe(false);
		expect(sharesFor(state, "friend", (id) => id === "friend")).toEqual(["friend-session"]);
		const dropped = dropDomain(state, "friend");
		expect(dropped.removed).toBe(1);
		expect(dropped.state.shares.map((share) => share.sessionTarget)).toEqual(["friend-session", "other"]);
	});

	it("honors an unlinked edge and preserves live shares during sweep", () => {
		const state = {
			shares: [
				{ sessionTarget: "stale", target: domain("friend"), lastSeenAt: 0 },
				{ sessionTarget: "live", target: domain("friend"), lastSeenAt: 0 },
			],
			unlinkedDomains: [{ domainId: "friend", edgeId: "edge-1" }],
		};
		expect(
			isSharedTo(
				state,
				"live",
				"friend",
				() => true,
				() => "edge-1",
			),
		).toBe(false);
		expect(
			sweep(state, 100, 10, (target) => target === "live").state.shares.map((share) => share.sessionTarget),
		).toEqual(["live"]);
	});
});
