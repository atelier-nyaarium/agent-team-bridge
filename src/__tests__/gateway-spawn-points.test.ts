// Who learns which host spawn points a machine offers, and who deliberately does not.
//
// A host spawn point is a SHELL on a machine, not a session. It is discovery metadata rather than a
// presence row precisely so it cannot become shareable: every kind TeamInfo permits is admitted by
// gatewayRelay's cross-Domain scope gate, so a row would make a machine's shell reachable in
// principle, which `host` has never been.

import { describe, expect, it } from "vitest";
import { createGatewayRelayHandler } from "../gateway/federation/gatewayRelay.js";
import { resolveWindowsWorkdir } from "../mcp/devcontainer/windowsSpawn.js";
import { GatewaySpawnPointsSchema } from "../shared/schemas.js";
import { gateRoutes } from "./helpers/federation.js";

////////////////////////////////
//  Functions & Helpers

function handler(shares: string[] = []) {
	const { routes } = gateRoutes([]);
	return createGatewayRelayHandler({
		routes: routes as never,
		tryWakeTeam: async () => ({ ok: false }),
		localGatewayId: "alice-gw",
		localDomainId: "alice",
		shareState: { sharesFor: () => shares, isSharedTo: () => shares.length > 0, touch: () => {} } as never,
	} as never).handleOp;
}

////////////////////////////////
//  Tests

describe("host spawn points over the mesh", () => {
	it("a same-Domain peer is told what this machine offers", async () => {
		const r = (await handler()({ kind: "list_teams" }, "alice-gw", null)) as { spawnPoints?: unknown[] };
		expect(r.spawnPoints).toEqual([{ domainId: "alice", gatewayId: "alice-gw", hostSpawns: ["windows"] }]);
	});

	// The whole reason this is not a presence row. A friend Domain learning that a machine runs
	// Windows is a fact about that machine, and a shell is not a session it can be granted.
	it("a cross-Domain caller is told nothing, even one with shares", async () => {
		const r = (await handler(["alice.alice-gw.host.abc"])({ kind: "list_teams" }, "peer", "carol")) as {
			spawnPoints?: unknown[];
		};
		expect(r.spawnPoints).toBeUndefined();
	});
});

// Shipped as a defect in the first draft and caught in audit. The "blank picker means the Windows
// home" branch was UNREACHABLE, because blank never arrives: SessionStore.hostWorkdirHint falls back
// to the session LABEL, so a session created without picking a directory carries its own name here.
// The old code handed that label to `wslpath -w`.
describe("a workdir hint that is a label, not a path", () => {
	const HOME = "C:\\Users\\me";

	it("falls back to the Windows home instead of translating the session label", () => {
		expect(resolveWindowsWorkdir("My Session", HOME)).toEqual({ workdir: HOME });
		expect(resolveWindowsWorkdir("recipe-app", HOME)).toEqual({ workdir: HOME });
	});

	it("no hint at all is the same answer", () => {
		expect(resolveWindowsWorkdir(undefined, HOME)).toEqual({ workdir: HOME });
	});

	// A drive path is already a Windows path, so it is passed through rather than round-tripped:
	// feeding one back through `wslpath -w` is not reliably a no-op.
	it("a drive path is taken as-is, in either slash spelling", () => {
		expect(resolveWindowsWorkdir("C:/Users/me/project", HOME)).toEqual({ workdir: "C:/Users/me/project" });
		expect(resolveWindowsWorkdir("D:\\work", HOME)).toEqual({ workdir: "D:\\work" });
	});
});

describe("the wire shape", () => {
	it("an empty hostSpawns is a valid, affirmative answer", () => {
		// Distinct from a Gateway that said nothing at all, which is what makes the row worth sending
		// even when there is nothing beyond `host` to report.
		expect(GatewaySpawnPointsSchema.safeParse({ gatewayId: "g", hostSpawns: [] }).success).toBe(true);
	});

	it("domainId is optional, for a Gateway that has not resolved one yet", () => {
		expect(GatewaySpawnPointsSchema.safeParse({ gatewayId: "g", hostSpawns: ["windows"] }).success).toBe(true);
	});

	it("is bounded, since it arrives from a peer", () => {
		const many = Array.from({ length: 9 }, (_, i) => `s${i}`);
		expect(GatewaySpawnPointsSchema.safeParse({ gatewayId: "g", hostSpawns: many }).success).toBe(false);
		expect(GatewaySpawnPointsSchema.safeParse({ gatewayId: "g", hostSpawns: [""] }).success).toBe(false);
	});
});
