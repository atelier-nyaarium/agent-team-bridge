import { describe, expect, it } from "vitest";
import type { Allowlist } from "../arbiter/federation/allowlist.js";
import { createHostRelayHandler } from "../arbiter/federation/hostRelay.js";
import { createSealer, type Sealer } from "../arbiter/federation/sealer.js";
import { createRoutes, type RoutesDeps } from "../arbiter/routes.js";
import { generateIdentity, type Identity, type SealedEnvelope } from "../shared/crypto.js";
import { type FederatedOp, FederatedOpSchema } from "../shared/federation-protocol.js";
import { Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";

////////////////////////////////
//  Harness

// Two admitted Hosts: each seals to the other (the allowlist resolution is mocked
// to the peer's keys; the trust model itself is tested in admission.test.ts).
const A = generateIdentity();
const B = generateIdentity();
function sealerFor(self: Identity, peers: Record<string, Identity>): Sealer {
	const allowlist = {
		resolveHost: (h: string) => (peers[h] ? { signPub: peers[h].sign.pub, boxPub: peers[h].box.pub } : null),
	} as unknown as Allowlist;
	return createSealer(self, allowlist);
}
const sealerA = sealerFor(A, { hostb: B });
const sealerB = sealerFor(B, { hosta: A });

interface FakeEvie {
	client: NonNullable<RoutesDeps["evieClient"]>;
	calls: { action: string; params: Record<string, unknown> }[];
}

/** A mock evie that, for host_relay, plays the DESTINATION Host: opens the sealed
 * op with the destination's sealer, runs `handle`, and seals the result back. */
function fakeEvie(opts: {
	destSealer?: Sealer;
	srcHost?: string;
	handle?: (op: FederatedOp) => unknown;
	onCall?: (action: string, params: Record<string, unknown>) => unknown;
}): FakeEvie {
	const calls: { action: string; params: Record<string, unknown> }[] = [];
	const client = {
		isConnected: () => true,
		getToolSchemas: () => [],
		stop: () => {},
		callTool: async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			if (action === "host_relay" && opts.destSealer && opts.srcHost && opts.handle) {
				const sealed = (params.payload as { sealed: SealedEnvelope }).sealed;
				const op = FederatedOpSchema.parse(opts.destSealer.open(opts.srcHost, sealed));
				const result = opts.handle(op);
				return { callId: "fake", result: { ok: true, result: opts.destSealer.seal(opts.srcHost, result) } };
			}
			return { callId: "fake", result: opts.onCall?.(action, params) ?? { ok: true } };
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
	return { readyState: 1, data: { mode: "channel" }, send: (d: string) => pushed.push(JSON.parse(d)) };
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

describe("federation routing (E2E sealed)", () => {
	it("ORIGIN: seals a cross-Host send with the return-route and keeps a local anchor", async () => {
		let seen: FederatedOp | undefined;
		const evie = fakeEvie({
			destSealer: sealerB,
			srcHost: "hosta",
			handle: (op) => {
				seen = op;
				return { session_id: "conv:conv-1:hostb/api", status: "running" };
			},
		});
		const ctx = makeCtx("hosta", { evieClient: evie.client, sealer: sealerA });
		const { send } = createRoutes(ctx);

		const res = await send(new Request("http://arbiter/send", { method: "POST" }), {
			from: "recipe-app",
			fromConversationId: "conv-1",
			to: "hostb/api",
			body: "status?",
			channelOnly: true,
		});
		const json = await res.json();
		expect(json.session_id).toBe("conv:conv-1:hostb/api");
		// The destination decrypted exactly the op we sealed (proves the E2E seal).
		expect(seen).toMatchObject({
			kind: "send",
			to: "api",
			from: "hosta/recipe-app",
			returnRoute: { srcHost: "hosta", srcSession: "conv:conv-1:hostb/api" },
		});
		// evie only ever saw an opaque sealed envelope, never the op.
		const relay = evie.calls.find((c) => c.action === "host_relay");
		expect((relay?.params.payload as { sealed: SealedEnvelope }).sealed.ciphertext).toBeTruthy();
		expect(JSON.stringify(relay?.params.payload)).not.toContain("recipe-app");
		expect(ctx.store.has("conv:conv-1:hostb/api")).toBe(true);
	});

	it("ORIGIN: 503 when the Router is unavailable", async () => {
		const evie = fakeEvie({});
		(evie.client as { isConnected: () => boolean }).isConnected = () => false;
		const { send } = createRoutes(makeCtx("hosta", { evieClient: evie.client, sealer: sealerA }));
		const res = await send(new Request("http://arbiter/send", { method: "POST" }), {
			from: "x",
			fromConversationId: "conv-1",
			to: "hostb/api",
			body: "hi",
			channelOnly: true,
		});
		expect(res.status).toBe(503);
	});

	it("DESTINATION: an inbound federated send lands locally and seals its reply home", async () => {
		let pinned: FederatedOp | undefined;
		const evie = fakeEvie({
			destSealer: sealerA,
			srcHost: "hostb",
			handle: (op) => {
				pinned = op;
				return { ok: true };
			},
		});
		const pushed: Record<string, unknown>[] = [];
		const ctx = makeCtx("hostb", {
			evieClient: evie.client,
			sealer: sealerB,
			registry: registryWith({ api: channelWs(pushed) }),
		});
		const routes = createRoutes(ctx);
		const handler = createHostRelayHandler({ routes, tryWakeTeam: ctx.tryWakeTeam });

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
		)) as { session_id: string };
		expect(result.session_id).toBe(srcSession);
		expect(pushed[0]).toMatchObject({ type: "channel_push", from: "hosta/recipe-app", session_id: srcSession });

		const respondRes = routes.respond(new Request("http://arbiter/respond", { method: "POST" }), {
			session_id: srcSession,
			status: "completed",
			response: "all good",
		});
		expect((await respondRes.json()).federated).toBe(true);
		// The reply-pin was sealed back to hosta and decrypts to the response_push.
		expect(pinned).toMatchObject({ kind: "response_push", session_id: srcSession, response: "all good" });
	});

	it("DESTINATION: a response_push pinned home delivers to the origin conversation", async () => {
		const senderPushes: Record<string, unknown>[] = [];
		const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
		conversationRegistry.set("conv-1", channelWs(senderPushes) as never);
		const ctx = makeCtx("hosta", { conversationRegistry });
		const srcSession = "conv:conv-1:hostb/api";
		ctx.store.create(srcSession, "recipe-app", "hostb/api", { persistent: true, fromConversationId: "conv-1" });
		const routes = createRoutes(ctx);
		const handler = createHostRelayHandler({ routes, tryWakeTeam: ctx.tryWakeTeam });

		const result = (await handler.handleOp(
			{ kind: "response_push", session_id: srcSession, status: "completed", response: "all good" },
			"hostb",
		)) as { ok: boolean };
		expect(result.ok).toBe(true);
		expect(senderPushes[0]).toMatchObject({ type: "response_push", session_id: srcSession, response: "all good" });
	});

	it("DISCOVERY: fans out a sealed list_teams over the evie roster and merges", async () => {
		const evie = fakeEvie({
			destSealer: sealerB,
			srcHost: "hosta",
			handle: () => ({
				teams: [{ team: "api", host: "hostb", status: "online", mode: "channel", queue_depth: 0 }],
			}),
			onCall: (action) =>
				action === "list_hosts" ? { hosts: [{ hostId: "hostb", online: true }] } : { ok: true },
		});
		const ctx = makeCtx("hosta", {
			evieClient: evie.client,
			sealer: sealerA,
			registry: registryWith({ "recipe-app": channelWs([]) }),
			knownTeamPaths: new Map([["recipe-app", "/x"]]),
		});
		const { discover } = createRoutes(ctx);

		const teams = (await (await discover()).json()) as { team: string; host?: string }[];
		expect(teams.find((t) => t.team === "recipe-app")?.host).toBe("hosta");
		expect(teams.find((t) => t.team === "api")?.host).toBe("hostb");
	});
});
