import { describe, expect, it } from "vitest";
import { createHostRelayHandler } from "../arbiter/federation/hostRelay.js";
import { createRoutes, type RoutesDeps } from "../arbiter/routes.js";
import { Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";

////////////////////////////////
//  Harness

interface FakeEvie {
	client: NonNullable<RoutesDeps["evieClient"]>;
	calls: { action: string; params: Record<string, unknown> }[];
}

/** A mock evie client that records host_relay calls and lets the test stub the
 * reply the Router would route back from the destination Host. */
function fakeEvie(onCall?: (action: string, params: Record<string, unknown>) => unknown): FakeEvie {
	const calls: { action: string; params: Record<string, unknown> }[] = [];
	const client = {
		isConnected: () => true,
		getToolSchemas: () => [],
		stop: () => {},
		callTool: async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			const result = onCall?.(action, params) ?? { ok: true };
			return { callId: "fake", result };
		},
	} as unknown as NonNullable<RoutesDeps["evieClient"]>;
	return { client, calls };
}

function makeCtx(localHostId: string, over: Partial<RoutesDeps> = {}): RoutesDeps {
	const targetLocks = new Map<string, Mutex>();
	const getMutex = ((team: string) => {
		if (!targetLocks.has(team)) targetLocks.set(team, new Mutex());
		return targetLocks.get(team)!;
	}) as RoutesDeps["getMutex"];
	getMutex.peek = (team: string) => targetLocks.get(team);
	return {
		registry: new Map() as RoutesDeps["registry"],
		conversationRegistry: new Map() as RoutesDeps["conversationRegistry"],
		store: new PendingJobStore<ResponsePayload>(),
		getMutex,
		config: { LOG_PATH: "/tmp/fed-test.log", RESPONSE_TIMEOUT_MS: 500, localHostId },
		tryWakeTeam: () => Promise.resolve(false),
		offlineCatalog: new Map(),
		knownTeamPaths: new Map(),
		...over,
	};
}

function channelWs(pushed: Record<string, unknown>[]) {
	return {
		readyState: 1,
		data: { mode: "channel" },
		send(data: string) {
			pushed.push(JSON.parse(data));
		},
	};
}

function registryWith(entries: Record<string, unknown>): RoutesDeps["registry"] {
	const registry = new Map() as RoutesDeps["registry"];
	for (const [team, ws] of Object.entries(entries)) {
		const subs = new Map();
		subs.set("sub-1", ws);
		registry.set(team, subs);
	}
	return registry;
}

////////////////////////////////
//  Tests

describe("federation routing", () => {
	it("ORIGIN: a cross-Host send forwards a host_relay with the return-route and keeps a local anchor", async () => {
		const evie = fakeEvie(() => ({ ok: true, result: { session_id: "conv:conv-1:hostb/api", status: "running" } }));
		const ctx = makeCtx("hosta", { evieClient: evie.client });
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://arbiter/send", { method: "POST" }), {
			from: "recipe-app",
			fromConversationId: "conv-1",
			to: "hostb/api",
			body: "status?",
			channelOnly: true,
		});
		const json = await res.json();

		// The origin owns the canonical session id and returns it immediately.
		expect(json.session_id).toBe("conv:conv-1:hostb/api");
		expect(json.status).toBe("running");
		// It forwarded exactly one host_relay to the destination Host...
		const relay = evie.calls.find((c) => c.action === "host_relay");
		expect(relay).toBeDefined();
		expect(relay?.params.dstHost).toBe("hostb");
		expect(relay?.params.srcHost).toBe("hosta");
		const op = (relay?.params.payload as { op: Record<string, unknown> }).op;
		expect(op).toMatchObject({
			kind: "send",
			to: "api",
			from: "hosta/recipe-app",
			body: "status?",
			returnRoute: { srcHost: "hosta", srcConversationId: "conv-1", srcSession: "conv:conv-1:hostb/api" },
		});
		// ...and kept a local pollable anchor under the canonical session id.
		expect(ctx.store.has("conv:conv-1:hostb/api")).toBe(true);
	});

	it("ORIGIN: 503 when the Router is unavailable", async () => {
		const evie = fakeEvie();
		(evie.client as { isConnected: () => boolean }).isConnected = () => false;
		const { send } = createRoutes(makeCtx("hosta", { evieClient: evie.client }));
		const res = await send(new Request("http://arbiter/send", { method: "POST" }), {
			from: "x",
			fromConversationId: "conv-1",
			to: "hostb/api",
			body: "hi",
			channelOnly: true,
		});
		expect(res.status).toBe(503);
	});

	it("DESTINATION: an inbound federated send lands locally and pins its reply home", async () => {
		const evie = fakeEvie();
		const pushed: Record<string, unknown>[] = [];
		const registry = registryWith({ api: channelWs(pushed) });
		const ctx = makeCtx("hostb", { evieClient: evie.client, registry });
		const routes = createRoutes(ctx);
		const handler = createHostRelayHandler({ routes, tryWakeTeam: ctx.tryWakeTeam });

		// The Router delivers a cross-Host send op to this (destination) Host.
		const srcSession = "conv:conv-1:hostb/api";
		const result = (await handler.handleOp(
			{
				kind: "send",
				from: "hosta/recipe-app",
				to: "api",
				body: "status?",
				returnRoute: { srcHost: "hosta", srcConversationId: "conv-1", srcSession },
			},
			"hosta",
		)) as { session_id: string; status: string };

		// It pushed a channel_push to the local team under the origin's session id.
		expect(result.session_id).toBe(srcSession);
		expect(pushed).toHaveLength(1);
		expect(pushed[0]).toMatchObject({ type: "channel_push", from: "hosta/recipe-app", session_id: srcSession });
		// The local job carries the return-route, so respond forwards home.
		expect(ctx.store.has(srcSession)).toBe(true);

		// The local team answers; respond must forward a response_push back to the origin Host.
		const respondRes = routes.respond(new Request("http://arbiter/respond", { method: "POST" }), {
			session_id: srcSession,
			status: "completed",
			response: "all good",
		});
		expect((await respondRes.json()).federated).toBe(true);
		const relay = evie.calls.find((c) => c.action === "host_relay");
		expect(relay?.params.dstHost).toBe("hosta");
		const op = (relay?.params.payload as { op: Record<string, unknown> }).op;
		expect(op).toMatchObject({
			kind: "response_push",
			session_id: srcSession,
			status: "completed",
			response: "all good",
		});
	});

	it("DESTINATION: a response_push pinned home delivers to the origin conversation", async () => {
		// On the ORIGIN Host: a prior cross-Host send left a local anchor whose
		// fromConversationId points at the sender's live socket.
		const senderPushes: Record<string, unknown>[] = [];
		const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
		conversationRegistry.set("conv-1", channelWs(senderPushes) as never);
		const ctx = makeCtx("hosta", { conversationRegistry });
		const srcSession = "conv:conv-1:hostb/api";
		ctx.store.create(srcSession, "recipe-app", "hostb/api", { persistent: true, fromConversationId: "conv-1" });
		const routes = createRoutes(ctx);
		const handler = createHostRelayHandler({ routes, tryWakeTeam: ctx.tryWakeTeam });

		// The Router delivers the destination Host's reply.
		const result = (await handler.handleOp(
			{ kind: "response_push", session_id: srcSession, status: "completed", response: "all good" },
			"hostb",
		)) as { ok: boolean };
		expect(result.ok).toBe(true);

		// The origin pushed the reply to the originating conversation (no re-forward:
		// the origin job has no return-route).
		expect(senderPushes).toHaveLength(1);
		expect(senderPushes[0]).toMatchObject({ type: "response_push", session_id: srcSession, response: "all good" });
	});

	it("DISCOVERY: fans out list_teams over the evie roster and merges with local teams", async () => {
		const evie = fakeEvie((action) => {
			if (action === "list_hosts") return { hosts: [{ hostId: "hostb", online: true }] };
			if (action === "host_relay") {
				return {
					ok: true,
					result: {
						teams: [{ team: "api", host: "hostb", status: "online", mode: "channel", queue_depth: 0 }],
					},
				};
			}
			return { ok: true };
		});
		const registry = registryWith({ "recipe-app": channelWs([]) });
		const ctx = makeCtx("hosta", {
			evieClient: evie.client,
			registry,
			knownTeamPaths: new Map([["recipe-app", "/x"]]),
		});
		const { discover } = createRoutes(ctx);

		const teams = (await (await discover()).json()) as { team: string; host?: string }[];
		// Local team carries the local Host; the peer's team carries its own Host.
		expect(teams.find((t) => t.team === "recipe-app")?.host).toBe("hosta");
		expect(teams.find((t) => t.team === "api")?.host).toBe("hostb");
		// evie was asked only for presence, then a per-Host list_teams fanned out.
		expect(evie.calls.some((c) => c.action === "list_hosts")).toBe(true);
		expect(evie.calls.some((c) => c.action === "host_relay")).toBe(true);
	});
});
