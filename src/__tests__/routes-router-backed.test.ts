import { describe, expect, it } from "vitest";
import { createRoutes } from "../gateway/routes.js";
import { makeCtx } from "./helpers/federation.js";

const projection = {
	plane: { epoch: 1, version: 2 },
	rows: [
		// This gateway's own row, which discovery must take from itself rather than from the Router.
		{
			team: "local.dev",
			gatewayId: "hosta",
			status: "online",
			kind: "devcontainer",
			queue_depth: 1,
		},
		{
			team: "peer.dev",
			gatewayId: "hostb",
			status: "online",
			kind: "devcontainer",
			queue_depth: 0,
		},
	],
	linked: [
		{
			domainId: "beta",
			version: { epoch: 1, version: 3 },
			lastRefreshedAt: 10,
			sessions: [
				{
					team: "remote.dev",
					gatewayId: "hostb",
					status: "available",
					kind: "loose",
					queueDepth: 2,
				},
			],
		},
	],
	roster: [],
	coverage: { rosterKnown: true, asked: 1, answered: 1 },
	spawnPoints: [
		{ domainId: "alice", gatewayId: "hosta", hostSpawns: ["linux"] },
		{ domainId: "alice", gatewayId: "hostb", hostSpawns: ["windows"] },
	],
};

function router(result: unknown, error?: string) {
	return {
		isConnected: () => true,
		isRegistered: () => !error,
		callInboxTool: async (action: string, params: Record<string, unknown>) => ({
			callId: "call",
			...(action === "presence_read" || action === "capabilities_read" ? { result, error } : { result: params }),
		}),
	} as never;
}

describe("Router-backed gateway routes", () => {
	it("folds the Router presence projection into discovery, keeping its own rows local", async () => {
		// Local sessions remain authoritative after a lost presence write.
		const routes = createRoutes({ ...makeCtx("hosta"), routerClient: router(projection) });

		expect(await routes.discoverFull()).toEqual({
			teams: [
				projection.rows[1],
				{
					team: "remote.dev",
					gatewayId: "hostb",
					status: "available",
					kind: "loose",
					domainId: "beta",
					queue_depth: 2,
				},
			],
			coverage: projection.coverage,
			spawnPoints: [projection.spawnPoints[1]],
		});
	});

	it("answers local discovery with unknown coverage when unregistered", async () => {
		const local = makeCtx("hosta");
		const routes = createRoutes({ ...local, routerClient: router(projection, "unregistered") });

		expect(await routes.discoverFull()).toMatchObject({
			teams: await (await routes.teams()).json(),
			coverage: { rosterKnown: false, asked: 0, answered: 0 },
		});
	});

	it("prefers the Router capability snapshot and falls back locally", async () => {
		const localSnapshot = { known: true, capabilities: [{ id: "local" }], clientVersions: ["local"] };
		const local = makeCtx("hosta", {
			capabilityStore: { snapshot: () => localSnapshot },
		});
		const remoteSnapshot = { known: true, capabilities: [{ id: "remote" }], clientVersions: ["remote"] };
		const preferred = createRoutes({ ...local, routerClient: router(remoteSnapshot) });
		expect(await (await preferred.capabilities()).json()).toMatchObject({ console: remoteSnapshot });

		const fallback = createRoutes({
			...local,
			routerClient: {
				isRegistered: () => true,
				callInboxTool: async () => ({ callId: "call", error: "offline" }),
			} as never,
		});
		expect(await (await fallback.capabilities()).json()).toMatchObject({ console: localSnapshot });
	});

	it("keeps the local answer when the Router knows nothing yet", async () => {
		// Unknown snapshots must not hide local capabilities.
		const localSnapshot = { known: true, capabilities: [{ id: "local" }], clientVersions: ["local"] };
		const local = makeCtx("hosta", { capabilityStore: { snapshot: () => localSnapshot } });
		const unknown = { known: false, capabilities: [], clientVersions: [] };
		const routes = createRoutes({ ...local, routerClient: router(unknown) });

		expect(await (await routes.capabilities()).json()).toMatchObject({ console: localSnapshot });
	});
});
