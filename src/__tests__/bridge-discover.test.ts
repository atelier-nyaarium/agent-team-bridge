import { describe, expect, it } from "vitest";
import {
	type DiscoverEntry,
	formatDiscoverLines,
	groupDiscoverEntries,
	relativeAge,
} from "../mcp/bridge/bridgeDiscover.js";

function entry(overrides: Partial<DiscoverEntry> & Pick<DiscoverEntry, "team" | "kind">): DiscoverEntry {
	return { status: "online", queue_depth: 0, gatewayId: "gw1", domainId: "alice", ...overrides };
}

describe("groupDiscoverEntries", () => {
	it("collapses a catalog project's bare devcontainer row and its composite session row into one group", () => {
		const groups = groupDiscoverEntries([
			entry({ team: "coolapp", kind: "devcontainer", status: "available" }),
			entry({ team: "coolapp.dev", kind: "loose" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ project: "coolapp", gatewayId: "gw1", domainId: "alice" });
		expect(groups[0].sessions).toHaveLength(1);
		expect(groups[0].sessions[0].team).toBe("coolapp.dev");
	});

	it("gives a session-less project a group with no sessions", () => {
		const groups = groupDiscoverEntries([entry({ team: "coolapp", kind: "devcontainer", status: "available" })]);
		expect(groups).toHaveLength(1);
		expect(groups[0].sessions).toEqual([]);
	});

	it("keeps identically-named projects on different gateways as separate groups", () => {
		const groups = groupDiscoverEntries([
			entry({ team: "coolapp.dev", kind: "loose", gatewayId: "gw1" }),
			entry({ team: "coolapp.dev", kind: "loose", gatewayId: "gw2" }),
		]);
		expect(groups).toHaveLength(2);
	});

	it("buckets multiple sessions of one project together", () => {
		const groups = groupDiscoverEntries([
			entry({ team: "coolapp.dev", kind: "loose" }),
			entry({ team: "coolapp.night", kind: "loose" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].sessions.map((s) => s.team)).toEqual(["coolapp.dev", "coolapp.night"]);
	});

	it("keeps a dotted catalog project name whole instead of splitting it on the dot", () => {
		const groups = groupDiscoverEntries([entry({ team: "my.app", kind: "devcontainer", status: "available" })]);
		expect(groups).toHaveLength(1);
		expect(groups[0].project).toBe("my.app");
	});

	it("skips an entry with a missing or non-string team instead of throwing", () => {
		const good = entry({ team: "coolapp.dev", kind: "loose" });
		const missing = { ...entry({ team: "", kind: "loose" }), team: undefined } as unknown as DiscoverEntry;
		const nonString = { ...entry({ team: "x", kind: "loose" }), team: 12345 } as unknown as DiscoverEntry;
		const malformed = [missing, nonString, good, null as unknown as DiscoverEntry];
		expect(() => groupDiscoverEntries(malformed)).not.toThrow();
		const groups = groupDiscoverEntries(malformed);
		expect(groups).toHaveLength(1);
		expect(groups[0].sessions[0].team).toBe("coolapp.dev");
	});

	it("drops every entry when all of them are malformed, leaving nothing to group", () => {
		const missing = { ...entry({ team: "", kind: "loose" }), team: undefined } as unknown as DiscoverEntry;
		expect(groupDiscoverEntries([missing, null as unknown as DiscoverEntry])).toEqual([]);
	});
});

describe("formatDiscoverLines", () => {
	it("renders a bare header for a session-less project with no nested lines", () => {
		const lines = formatDiscoverLines([entry({ team: "coollib", kind: "devcontainer", status: "available" })]);
		expect(lines).toEqual(["- alice.gw1.coollib"]);
	});

	it("nests an online session's full address under its project header", () => {
		const lines = formatDiscoverLines([entry({ team: "coolapp.dev", kind: "loose", status: "online" })]);
		expect(lines).toEqual(["- alice.gw1.coolapp", "  - alice.gw1.coolapp.dev: online"]);
	});

	it("shows an asleep session's recency and a session label alongside its address", () => {
		const lines = formatDiscoverLines([
			entry({
				team: "coolapp.dev",
				kind: "loose",
				status: "available",
				lastActive: Date.now() - 5 * 60_000,
				sessionLabel: "Bug Investigation",
			}),
		]);
		expect(lines[1]).toBe(`  - Bug Investigation (alice.gw1.coolapp.dev): asleep, last seen 5m ago`);
	});

	it("merges a catalog project's bare row with its session row into one header, one child", () => {
		const lines = formatDiscoverLines([
			entry({ team: "coolapp", kind: "devcontainer", status: "available" }),
			entry({ team: "coolapp.dev", kind: "loose", status: "online" }),
		]);
		expect(lines).toEqual(["- alice.gw1.coolapp", "  - alice.gw1.coolapp.dev: online"]);
	});

	it("renders a dotted catalog project's full name in its header, not a truncated segment", () => {
		// A dotted project name fails the address grammar's slug check, so the header falls back to
		// the bare project name (no domain/gateway prefix) - a separate, pre-existing limitation of
		// that grammar. What this guards is the fix's actual scope: the header must read the whole
		// "my.app", not the "my" a naive dot-split on `team` would produce.
		const lines = formatDiscoverLines([entry({ team: "my.app", kind: "devcontainer", status: "available" })]);
		expect(lines).toEqual(["- my.app"]);
	});

	it("renders no lines when every entry is malformed, so the caller falls back to its no-sessions message", () => {
		const missing = { ...entry({ team: "", kind: "loose" }), team: undefined } as unknown as DiscoverEntry;
		expect(formatDiscoverLines([missing, null as unknown as DiscoverEntry])).toEqual([]);
	});
});

describe("relativeAge", () => {
	const now = 1_000_000_000_000;
	it("reads under a minute as just now", () => {
		expect(relativeAge(now - 30_000, now)).toBe("just now");
		expect(relativeAge(now, now)).toBe("just now");
	});
	it("buckets minutes, hours, and days", () => {
		expect(relativeAge(now - 5 * 60_000, now)).toBe("5m ago");
		expect(relativeAge(now - 2 * 3_600_000, now)).toBe("2h ago");
		expect(relativeAge(now - 3 * 86_400_000, now)).toBe("3d ago");
	});
	it("clamps a future timestamp to just now (no negative age)", () => {
		expect(relativeAge(now + 10_000, now)).toBe("just now");
	});
});
