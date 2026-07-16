import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeCoordinator } from "../gateway/wake.js";
import {
	type ConversationRegistry,
	createWebSocketHandlers,
	resolveLiveIncarnation,
	type TeamRegistry,
	type WsData,
} from "../gateway/websocket.js";
import { SessionStore } from "../shared/session-store.js";

const HOST_TOKEN = "host-secret";

function createMockWs() {
	return {
		data: { teamName: null, subId: "", conversationId: null, missedPings: 0, isStale: false } as WsData,
		readyState: 1,
		close: vi.fn(),
		ping: vi.fn(),
		send: vi.fn(),
	} as unknown as import("bun").ServerWebSocket<WsData>;
}

/** The random `hs-...` session id the gateway sent this socket in its handshake push. */
function handshakeIdFrom(ws: import("bun").ServerWebSocket<WsData>): string {
	const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(c[0] as string));
	const hs = calls.reverse().find((m) => m.type === "channel_push" && m.from === "gateway" && m.replyJsonSchema);
	return hs.session_id as string;
}

/** How many handshake pushes this socket has been sent in total. */
function handshakePushCount(ws: import("bun").ServerWebSocket<WsData>): number {
	const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(c[0] as string));
	return calls.filter((m) => m.type === "channel_push" && m.from === "gateway" && m.replyJsonSchema).length;
}

describe("createWebSocketHandlers", () => {
	let intervals: ReturnType<typeof setInterval>[] = [];
	afterEach(() => {
		for (const id of intervals) clearInterval(id);
		intervals = [];
	});

	function setup(
		overrides: {
			registry?: TeamRegistry;
			conversationRegistry?: ConversationRegistry;
			knownTeamPaths?: Map<string, string>;
			offlineCatalog?: Map<string, string>;
			wakeCoordinator?: WakeCoordinator;
			hostWsToken?: string;
			hostOpCoordinator?: { settle: ReturnType<typeof vi.fn>; failAll: ReturnType<typeof vi.fn> };
		} = {},
	) {
		const registry: TeamRegistry = overrides.registry || new Map();
		const conversationRegistry: ConversationRegistry = overrides.conversationRegistry || new Map();
		const knownTeamPaths = overrides.knownTeamPaths || new Map();
		const offlineCatalog = overrides.offlineCatalog || new Map();
		const wakeCoordinator = overrides.wakeCoordinator || new WakeCoordinator();
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry,
			config: {
				HEARTBEAT_INTERVAL_MS: 100000,
				MISSED_PINGS_LIMIT: 2,
				hostWsToken: "hostWsToken" in overrides ? overrides.hostWsToken : HOST_TOKEN,
			},
			knownTeamPaths,
			offlineCatalog,
			wakeCoordinator,
			hostOpCoordinator: overrides.hostOpCoordinator as
				| {
						settle: (
							reqId: string,
							result: { ok: boolean; result?: unknown; error?: string; errorKind?: "absent" | "failure" },
						) => void;
						failAll: (error: string) => void;
				  }
				| undefined,
		});
		intervals.push(handlers.heartbeatInterval);
		return {
			handlers,
			registry,
			conversationRegistry,
			knownTeamPaths,
			offlineCatalog,
			wakeCoordinator,
		};
	}

	it("reserved name squatters are rejected after first registration", () => {
		const { handlers, registry } = setup();
		const ws1 = createMockWs();
		const ws2 = createMockWs();
		handlers.open(ws1);
		handlers.open(ws2);
		handlers.message(ws1, JSON.stringify({ type: "register", team: "host", subId: "a1", token: HOST_TOKEN }));
		handlers.message(ws2, JSON.stringify({ type: "register", team: "host", subId: "a2", token: HOST_TOKEN }));
		const subs = registry.get("host");
		expect(subs!.size).toBe(1);
		expect(subs!.get("a1")).toBe(ws1);
		expect(ws2.close).toHaveBeenCalled();
	});

	it("with a host token set, a host register with a wrong/missing token is rejected", () => {
		const { handlers, registry } = setup({ hostWsToken: "secret" });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		expect(registry.get("host")).toBeUndefined();
		expect(ws.close).toHaveBeenCalled();
		expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.flat().join()).toContain("unauthorized");
	});

	it("with a host token set, the correct token registers the host", () => {
		const { handlers, registry } = setup({ hostWsToken: "secret" });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: "secret" }));
		expect(registry.get("host")?.get("h1")).toBe(ws);
	});

	it("with NO host token configured, a host register is rejected (fail-closed)", () => {
		const { handlers, registry } = setup({ hostWsToken: undefined });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: "anything" }));
		expect(registry.get("host")).toBeUndefined();
		expect(ws.close).toHaveBeenCalled();
	});

	it("a host_op_reply from the host socket settles the coordinator by reqId", () => {
		const hostOpCoordinator = { settle: vi.fn(), failAll: vi.fn() };
		const { handlers } = setup({ hostOpCoordinator });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		handlers.message(ws, JSON.stringify({ type: "host_op_reply", reqId: "r1", ok: true, result: { hash: "h" } }));
		expect(hostOpCoordinator.settle).toHaveBeenCalledWith("r1", {
			ok: true,
			result: { hash: "h" },
			error: undefined,
		});
	});

	it("a host_op_reply from a NON-host socket is ignored (cannot settle a terminal op)", () => {
		const hostOpCoordinator = { settle: vi.fn(), failAll: vi.fn() };
		const { handlers } = setup({ hostOpCoordinator });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));
		handlers.message(ws, JSON.stringify({ type: "host_op_reply", reqId: "r1", ok: true }));
		expect(hostOpCoordinator.settle).not.toHaveBeenCalled();
	});

	it("fails all in-flight host ops when the host socket disconnects", () => {
		const hostOpCoordinator = { settle: vi.fn(), failAll: vi.fn() };
		const { handlers } = setup({ hostOpCoordinator });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		handlers.close(ws);
		expect(hostOpCoordinator.failAll).toHaveBeenCalledWith("host daemon disconnected");
	});

	it("fails an in-flight wake when the host socket disconnects (no full-timeout stall)", async () => {
		const { handlers, wakeCoordinator } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		// doWakeTeam awaits this with WAKE_TIMEOUT_MS (10 min in prod). The long timeout stands in for
		// that: if the host drop does not fail the waiter, this never resolves and the test times out.
		const wake = wakeCoordinator.waitFor("proj-a.main", 10_000);
		handlers.close(ws);
		await expect(wake).resolves.toEqual({ ok: false, errorKind: "disconnected" });
	}, 2000);

	it("routes a host wake_result success to ackReceived and a failure to notify", () => {
		const { handlers, wakeCoordinator } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		const ack = vi.spyOn(wakeCoordinator, "ackReceived");
		const notify = vi.spyOn(wakeCoordinator, "notify");

		handlers.message(ws, JSON.stringify({ type: "wake_result", team: "proj-a.main", success: true }));
		expect(ack).toHaveBeenCalledWith("proj-a.main", expect.any(Number));
		expect(notify).not.toHaveBeenCalled();

		handlers.message(ws, JSON.stringify({ type: "wake_result", team: "proj-b.main", success: false }));
		expect(notify).toHaveBeenCalledWith("proj-b.main", false);
	});

	it("a wake_result from a NON-host socket is ignored (cannot forge a wake outcome)", () => {
		const { handlers, wakeCoordinator } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));
		const ack = vi.spyOn(wakeCoordinator, "ackReceived");
		const notify = vi.spyOn(wakeCoordinator, "notify");
		handlers.message(ws, JSON.stringify({ type: "wake_result", team: "victim", success: false }));
		expect(ack).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("register message adds team to registry", () => {
		const { handlers, registry } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));
		const subs = registry.get("alpha");
		expect(subs).toBeDefined();
		expect(subs!.get("s1")).toBe(ws);
	});

	it("multiple sub-sessions coexist under same team", () => {
		const { handlers, registry } = setup();
		const ws1 = createMockWs();
		const ws2 = createMockWs();
		handlers.open(ws1);
		handlers.open(ws2);
		handlers.message(ws1, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));
		handlers.message(ws2, JSON.stringify({ type: "register", team: "alpha", subId: "s2" }));

		const subs = registry.get("alpha");
		expect(subs!.size).toBe(2);
		expect(subs!.get("s1")).toBe(ws1);
		expect(subs!.get("s2")).toBe(ws2);
		expect(ws1.close).not.toHaveBeenCalled();
	});

	it("re-registration with same subId closes stale socket", () => {
		const { handlers, registry } = setup();
		const ws1 = createMockWs();
		handlers.open(ws1);
		handlers.message(ws1, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));

		const ws2 = createMockWs();
		handlers.open(ws2);
		handlers.message(ws2, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));

		expect(ws1.close).toHaveBeenCalled();
		expect(registry.get("alpha")!.get("s1")).toBe(ws2);
	});

	it("disconnect removes sub from team, keeps team if other subs remain", () => {
		const { handlers, registry } = setup();
		const ws1 = createMockWs();
		const ws2 = createMockWs();
		handlers.open(ws1);
		handlers.open(ws2);
		handlers.message(ws1, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));
		handlers.message(ws2, JSON.stringify({ type: "register", team: "alpha", subId: "s2" }));

		handlers.close(ws1);
		expect(registry.has("alpha")).toBe(true);
		expect(registry.get("alpha")!.size).toBe(1);
		expect(registry.get("alpha")!.has("s2")).toBe(true);
	});

	it("last sub disconnect removes team from registry", () => {
		const { handlers, registry } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));
		handlers.close(ws);
		expect(registry.has("alpha")).toBe(false);
	});

	it("stale close does not remove sub from registry", () => {
		const { handlers, registry } = setup();
		const ws1 = createMockWs();
		handlers.open(ws1);
		handlers.message(ws1, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));

		const ws2 = createMockWs();
		handlers.open(ws2);
		handlers.message(ws2, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));

		// ws1 close fires late (marked stale by re-registration)
		handlers.close(ws1);
		expect(registry.get("alpha")!.get("s1")).toBe(ws2);
	});

	it("invalid JSON message is silently ignored", () => {
		const { handlers, registry } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, "not json{{{");
		expect(registry.size).toBe(0);
	});

	it("catalog from host populates offlineCatalog", () => {
		const { handlers, offlineCatalog } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		handlers.message(
			ws,
			JSON.stringify({
				type: "catalog",
				projects: [
					{ team: "proj-a", projectPath: "/home/user/proj-a" },
					{ team: "proj-b", projectPath: "/home/user/proj-b" },
				],
			}),
		);
		expect(offlineCatalog.size).toBe(2);
		expect(offlineCatalog.get("proj-a")).toBe("/home/user/proj-a");
	});

	it("catalog from non-host is ignored", () => {
		const { handlers, offlineCatalog } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "some-team", subId: "s1" }));
		handlers.message(
			ws,
			JSON.stringify({
				type: "catalog",
				projects: [{ team: "proj-a", projectPath: "/home/user/proj-a" }],
			}),
		);
		expect(offlineCatalog.size).toBe(0);
	});

	it("host disconnect clears offlineCatalog", () => {
		const { handlers, offlineCatalog } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		handlers.message(
			ws,
			JSON.stringify({
				type: "catalog",
				projects: [{ team: "proj-a", projectPath: "/home/user/proj-a" }],
			}),
		);
		expect(offlineCatalog.size).toBe(1);
		handlers.close(ws);
		expect(offlineCatalog.size).toBe(0);
	});

	it("catalog populates knownTeamPaths only for new teams", () => {
		const knownTeamPaths = new Map<string, string>();
		knownTeamPaths.set("proj-a", "/existing/path");
		const { handlers } = setup({ knownTeamPaths });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		handlers.message(
			ws,
			JSON.stringify({
				type: "catalog",
				projects: [
					{ team: "proj-a", projectPath: "/catalog/proj-a" },
					{ team: "proj-b", projectPath: "/catalog/proj-b" },
				],
			}),
		);
		expect(knownTeamPaths.get("proj-a")).toBe("/existing/path");
		expect(knownTeamPaths.get("proj-b")).toBe("/catalog/proj-b");
	});

	it("a non-host register seeds knownTeamPaths but never offlineCatalog (the connector SSRF gate trusts only the host catalog)", () => {
		const { handlers, knownTeamPaths, offlineCatalog } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		// An unauthenticated /bridge register can name itself anything (no host token), so it may land in
		// knownTeamPaths - but must never reach offlineCatalog, the host-token-gated source the connector
		// proxy gate dials from. Otherwise a register of "localhost" could SSRF ws://localhost:20002.
		handlers.message(ws, JSON.stringify({ type: "register", team: "localhost", subId: "s1", projectPath: "/tmp" }));
		expect(knownTeamPaths.get("localhost")).toBe("/tmp");
		expect(offlineCatalog.has("localhost")).toBe(false);
	});
});

describe("virtual peer awareness", () => {
	let intervals: ReturnType<typeof setInterval>[] = [];
	afterEach(() => {
		for (const id of intervals) clearInterval(id);
		intervals = [];
	});

	function setup() {
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const evicted: string[] = [];
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
			knownTeamPaths: new Map(),
			offlineCatalog: new Map(),
			wakeCoordinator: new WakeCoordinator(),
			onVirtualPeerEvicted: (conversationId) => evicted.push(conversationId),
		});
		intervals.push(handlers.heartbeatInterval);
		return { handlers, registry, conversationRegistry, evicted };
	}

	function createVirtualWs(team: string, conversationId: string) {
		const ws = createMockWs();
		ws.data.teamName = team;
		ws.data.subId = conversationId;
		ws.data.conversationId = conversationId;
		ws.data.virtual = true;
		return ws;
	}

	it("a real registration evicts virtual console squatters and their conversation pointers", () => {
		const { handlers, registry, conversationRegistry, evicted } = setup();
		const squatter = createVirtualWs("teamx", "conv-1");
		registry.set("teamx", new Map([["conv-1", squatter]]));
		conversationRegistry.set("conv-1", squatter);

		const real = createMockWs();
		handlers.open(real);
		handlers.message(
			real,
			JSON.stringify({
				type: "register",
				team: "teamx",
				subId: "r1",
				mode: "channel",
				conversationId: "conv-real",
			}),
		);

		const subs = registry.get("teamx");
		expect(subs?.has("conv-1")).toBe(false);
		expect(subs?.has("r1")).toBe(true);
		expect(conversationRegistry.get("conv-1")).toBeUndefined();
		expect(evicted).toEqual(["conv-1"]);
	});

	it("close cleanup is not suppressed by a lingering virtual sub", () => {
		const { handlers, registry } = setup();

		const real = createMockWs();
		handlers.open(real);
		handlers.message(real, JSON.stringify({ type: "register", team: "teamx", subId: "r1", mode: "channel" }));

		// Virtual sub lands beside the real one after registration.
		const subs = registry.get("teamx");
		subs?.set("conv-1", createVirtualWs("teamx", "conv-1"));

		handlers.close(real);

		// Virtual sub keeps the entry alive; the real sub's slot is cleaned up.
		expect(registry.get("teamx")?.size).toBe(1);
		expect(registry.get("teamx")?.has("conv-1")).toBe(true);
	});
});

// The handshake confirm is the ceremony that establishes a durable session record: register only
// stashes the reported ids, the confirm binds/creates and stamps liveTeam. These pin the binding
// order, the register-time no-write, the readyState gate, and full socket eviction cleanup.
describe("handshake-established session records", () => {
	let intervals: ReturnType<typeof setInterval>[] = [];
	afterEach(() => {
		for (const id of intervals) clearInterval(id);
		intervals = [];
	});

	function setup(sessionStore = new SessionStore()) {
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
			knownTeamPaths: new Map(),
			offlineCatalog: new Map(),
			wakeCoordinator: new WakeCoordinator(),
			sessionStore,
		});
		intervals.push(handlers.heartbeatInterval);
		return { handlers, registry, conversationRegistry, sessionStore };
	}

	function register(
		handlers: ReturnType<typeof setup>["handlers"],
		ws: ReturnType<typeof createMockWs>,
		msg: object,
	) {
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", mode: "channel", ...msg }));
	}

	it("register alone writes no record (recording is deferred to the confirm)", () => {
		const { handlers, sessionStore } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "host.abc123", subId: "s1", claudeSessionId: "tx-1", cwdName: "switchboard" });
		expect(sessionStore.size).toBe(0);
	});

	it("a lead confirm on a free segment adopts it, labels by cwd, and stamps the record live", () => {
		const { handlers, sessionStore } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "host.abc123", subId: "s1", claudeSessionId: "tx-1", cwdName: "switchboard" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });

		const record = sessionStore.getByTeam("host.abc123");
		expect(record).toMatchObject({
			id: "abc123",
			spawn: "host",
			sessionLabel: "switchboard",
			claudeSessionId: "tx-1",
			liveTeam: { team: "host.abc123", subId: "s1" },
		});
		expect(record?.confirmedAt).toBeGreaterThan(0);
		expect(ws.data.handshakeConfirmed).toBe(true);
	});

	it("a worker reply records nothing and fully removes the socket from the registry", () => {
		const { handlers, registry, conversationRegistry, sessionStore } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "host.abc123", subId: "s1", conversationId: "conv-w", claudeSessionId: "tx-1" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: false });

		expect(sessionStore.size).toBe(0);
		expect(registry.get("host.abc123")?.has("s1")).toBeFalsy();
		expect(conversationRegistry.has("conv-w")).toBe(false);
		expect(ws.close).toHaveBeenCalled();
		expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.flat().join()).toContain("handshake_reject");
	});

	it("a confirm arriving after the socket went un-open is ignored (no record)", () => {
		const { handlers, sessionStore } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "host.abc123", subId: "s1", claudeSessionId: "tx-1" });
		const hsId = handshakeIdFrom(ws);
		(ws as { readyState: number }).readyState = 3;
		expect(handlers.resolveHandshake(hsId, { isMainOrLead: true })).toBe(true);
		expect(sessionStore.size).toBe(0);
		expect(ws.data.handshakeConfirmed).toBe(false);
	});

	it("disconnect clears the live pointer but keeps the record (asleep, resumable)", () => {
		const { handlers, sessionStore } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "host.abc123", subId: "s1", claudeSessionId: "tx-1", cwdName: "switchboard" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });
		handlers.close(ws);

		const record = sessionStore.getByTeam("host.abc123");
		expect(record).toBeDefined();
		expect(record?.liveTeam).toBeUndefined();
		expect(record?.claudeSessionId).toBe("tx-1");
	});

	it("evicting a confirmed socket on reconnect clears its now-stale live pointer", () => {
		const { handlers, sessionStore } = setup();
		const ws1 = createMockWs();
		register(handlers, ws1, {
			team: "host.abc123",
			subId: "s1",
			conversationId: "conv-x",
			claudeSessionId: "tx-1",
		});
		handlers.resolveHandshake(handshakeIdFrom(ws1), { isMainOrLead: true });
		expect(sessionStore.getByTeam("host.abc123")?.liveTeam).toEqual({ team: "host.abc123", subId: "s1" });

		// The same process reconnects: a fresh subId under the stable conversationId evicts ws1.
		const ws2 = createMockWs();
		register(handlers, ws2, { team: "host.abc123", subId: "s2", conversationId: "conv-x" });
		expect(ws1.close).toHaveBeenCalled();
		expect(sessionStore.getByTeam("host.abc123")?.liveTeam).toBeUndefined();
	});

	it("a sibling sub-session's worker-reject does not clear the confirmed lead's live pointer", () => {
		const { handlers, sessionStore } = setup();
		const lead = createMockWs();
		register(handlers, lead, {
			team: "host.abc123",
			subId: "s1",
			conversationId: "conv-a",
			claudeSessionId: "tx-1",
		});
		handlers.resolveHandshake(handshakeIdFrom(lead), { isMainOrLead: true });

		// A separate sub-session under the same team answers as worker and is evicted.
		const worker = createMockWs();
		register(handlers, worker, { team: "host.abc123", subId: "s2", conversationId: "conv-b" });
		handlers.resolveHandshake(handshakeIdFrom(worker), { isMainOrLead: false });

		expect(worker.close).toHaveBeenCalled();
		expect(sessionStore.getByTeam("host.abc123")?.liveTeam).toEqual({ team: "host.abc123", subId: "s1" });
	});

	it("first-binding-holds: a second live incarnation of the same transcript is refused a record", () => {
		const { handlers, sessionStore } = setup();
		const ws1 = createMockWs();
		register(handlers, ws1, { team: "host.abc", subId: "s1", claudeSessionId: "tx-1" });
		handlers.resolveHandshake(handshakeIdFrom(ws1), { isMainOrLead: true });
		expect(sessionStore.getByTeam("host.abc")?.liveTeam).toEqual({ team: "host.abc", subId: "s1" });

		// A second live socket under a DIFFERENT segment claims the same transcript while ws1 is live.
		const ws2 = createMockWs();
		register(handlers, ws2, { team: "host.def", subId: "s2", claudeSessionId: "tx-1" });
		handlers.resolveHandshake(handshakeIdFrom(ws2), { isMainOrLead: true });

		// Refused: no record for the second segment, and the first record's live pointer is not stolen.
		expect(sessionStore.getByTeam("host.def")).toBeUndefined();
		expect(sessionStore.getByTeam("host.abc")?.liveTeam).toEqual({ team: "host.abc", subId: "s1" });
		expect(sessionStore.size).toBe(1);
	});

	it("re-registering a subId prunes the evicted socket's pending handshake", () => {
		const { handlers } = setup();
		const ws1 = createMockWs();
		register(handlers, ws1, { team: "host.abc123", subId: "s1" });
		const staleHsId = handshakeIdFrom(ws1);

		const ws2 = createMockWs();
		register(handlers, ws2, { team: "host.abc123", subId: "s1" });
		expect(ws1.close).toHaveBeenCalled();

		expect(handlers.resolveHandshake(staleHsId, { isMainOrLead: true })).toBe(false);
		expect(handlers.resolveHandshake(handshakeIdFrom(ws2), { isMainOrLead: true })).toBe(true);
	});

	it("sends exactly one handshake at register and never re-sends it on a heartbeat tick", () => {
		const { handlers } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
		const first = handshakeIdFrom(ws);
		expect(handshakePushCount(ws)).toBe(1);
		handlers.heartbeatTick();
		handlers.heartbeatTick();
		expect(handshakePushCount(ws)).toBe(1);
		expect(handshakeIdFrom(ws)).toBe(first);
	});

	it("stops sending handshake pushes once the session confirms", () => {
		const { handlers } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });
		expect(ws.data.handshakeConfirmed).toBe(true);
		handlers.heartbeatTick();
		expect(handshakePushCount(ws)).toBe(1);
	});

	it("a pending handshake answered after many heartbeat ticks still confirms (no TTL cliff)", () => {
		const { handlers } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
		const hsId = handshakeIdFrom(ws);
		for (let i = 0; i < 50; i++) handlers.heartbeatTick();
		expect(handlers.resolveHandshake(hsId, { isMainOrLead: true })).toBe(true);
	});

	it("a register carrying the remembered lead role confirms silently, with no handshake push at all, once the team has answered a real handshake before", () => {
		const { handlers, registry, sessionStore } = setup();
		// A genuine first connection answers the real challenge, so the team earns the shortcut.
		const first = createMockWs();
		register(handlers, first, { team: "recipe-app.abc123", subId: "s1", claudeSessionId: "tx-1" });
		expect(handshakePushCount(first)).toBe(1);
		handlers.resolveHandshake(handshakeIdFrom(first), { isMainOrLead: true });
		handlers.close(first);

		// A reconnect claiming the remembered role is now honored with no prompt.
		const ws = createMockWs();
		register(handlers, ws, {
			team: "recipe-app.abc123",
			subId: "s2",
			claudeSessionId: "tx-1",
			isMainOrLead: true,
		});
		expect(handshakePushCount(ws)).toBe(0);
		expect(sessionStore.getByTeam("recipe-app.abc123")?.liveTeam).toEqual({
			team: "recipe-app.abc123",
			subId: "s2",
		});
		expect(resolveLiveIncarnation(registry, sessionStore, "recipe-app.abc123")).toBe(ws);
	});

	it("a register carrying isMainOrLead:true for a team never confirmed before is still challenged", () => {
		const { sessionStore, handlers } = setup();
		const ws = createMockWs();
		register(handlers, ws, {
			team: "fresh-app.xyz789",
			subId: "s1",
			isMainOrLead: true,
		});
		expect(handshakePushCount(ws)).toBe(1);
		expect(sessionStore.getByTeam("fresh-app.xyz789")).toBeUndefined();
	});

	describe("repushHandshake (recovery from a lost hs-* notification)", () => {
		// Fakes ONLY Date (repushHandshake's guards read Date.now()), leaving setInterval/clearInterval
		// real so the outer describe's heartbeatInterval tracking/cleanup is unaffected.
		afterEach(() => {
			vi.useRealTimers();
		});

		/** Move the faked clock forward by ms. */
		function advance(ms: number): void {
			vi.setSystemTime(Date.now() + ms);
		}

		it("throttles a call within the dedupe window of the last push", () => {
			const { handlers } = setup();
			const ws = createMockWs();
			register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
			expect(handshakePushCount(ws)).toBe(1);

			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("throttled");
			expect(handshakePushCount(ws)).toBe(1);
		});

		it("past the dedupe window, re-sends the SAME id and answering it still confirms normally", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const { handlers } = setup();
			const ws = createMockWs();
			register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
			const first = handshakeIdFrom(ws);

			advance(3001);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("pushed");
			expect(handshakePushCount(ws)).toBe(2);
			expect(handshakeIdFrom(ws)).toBe(first);

			// An immediate second attempt (e.g. a same-batch double 409) collapses into the push just sent.
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("throttled");
			expect(handshakePushCount(ws)).toBe(2);

			expect(handlers.resolveHandshake(first, { isMainOrLead: true })).toBe(true);
			expect(ws.data.handshakeConfirmed).toBe(true);
		});

		it("repeated re-pushes never mint a second pending entry for the same id", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const { handlers } = setup();
			const ws = createMockWs();
			register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
			const first = handshakeIdFrom(ws);

			advance(3001);
			handlers.repushHandshake("recipe-app.abc123", "s1");
			advance(3001);
			handlers.repushHandshake("recipe-app.abc123", "s1");
			expect(handshakeIdFrom(ws)).toBe(first);

			// Resolving the id ONCE fully clears it - an orphaned duplicate entry would leave a residual
			// pending id behind, and repushHandshake would report "pushed"/"throttled" instead of this.
			expect(handlers.resolveHandshake(first, { isMainOrLead: true })).toBe(true);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("no-pending");
		});

		it("caps total attempts, then refuses further pushes while the id stays answerable", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const { handlers } = setup();
			const ws = createMockWs();
			register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
			const first = handshakeIdFrom(ws);

			for (let i = 0; i < 5; i++) {
				advance(3001);
				expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("pushed");
			}
			expect(handshakePushCount(ws)).toBe(6); // 1 mint + 5 repushes

			advance(3001);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("capped");
			expect(handshakePushCount(ws)).toBe(6); // no further push sent

			expect(handshakeIdFrom(ws)).toBe(first);
			expect(handlers.resolveHandshake(first, { isMainOrLead: true })).toBe(true);
		});

		it("reports no-pending once the handshake is already confirmed, and for an unregistered team", () => {
			const { handlers } = setup();
			const ws = createMockWs();
			register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
			handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });

			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("no-pending");
			expect(handlers.repushHandshake("nowhere", "s1")).toBe("no-pending");
			expect(handshakePushCount(ws)).toBe(1);
		});

		it("reports socket-gone rather than sending to a non-open socket", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const { handlers } = setup();
			const ws = createMockWs();
			register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
			(ws as { readyState: number }).readyState = 3;

			advance(3001);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("socket-gone");
			expect(handshakePushCount(ws)).toBe(1);
		});

		it("reports socket-gone (not a crash) when the send itself throws on an open socket", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const { handlers } = setup();
			const ws = createMockWs();
			register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
			(ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error("boom");
			});

			advance(3001);
			expect(() => handlers.repushHandshake("recipe-app.abc123", "s1")).not.toThrow();
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("socket-gone");
		});

		it("mintHandshake itself survives a register-time send failure, leaving the entry recoverable", () => {
			const { handlers } = setup();
			const ws = createMockWs();
			(ws.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
				throw new Error("boom");
			});

			expect(() => register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" })).not.toThrow();

			const hsId = handshakeIdFrom(ws);
			expect(hsId).toBeDefined();
			expect(handlers.resolveHandshake(hsId, { isMainOrLead: true })).toBe(true);
			expect(ws.data.handshakeConfirmed).toBe(true);
		});

		it("each sibling's own first repush attempt succeeds regardless of another sibling's more recent one (no starvation)", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const { handlers } = setup();
			const ws1 = createMockWs();
			const ws2 = createMockWs();
			const ws3 = createMockWs();
			register(handlers, ws1, { team: "recipe-app.abc123", subId: "s1" });
			register(handlers, ws2, { team: "recipe-app.abc123", subId: "s2" });
			register(handlers, ws3, { team: "recipe-app.abc123", subId: "s3" });

			advance(3001);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("pushed");
			expect(handlers.repushHandshake("recipe-app.abc123", "s2")).toBe("pushed");
			expect(handlers.repushHandshake("recipe-app.abc123", "s3")).toBe("pushed");
		});

		it("a repeat attempt is still throttled by a more recent team-wide push from a sibling", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const { handlers } = setup();
			const ws1 = createMockWs();
			const ws2 = createMockWs();
			register(handlers, ws1, { team: "recipe-app.abc123", subId: "s1" });
			register(handlers, ws2, { team: "recipe-app.abc123", subId: "s2" });

			advance(3001);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("pushed"); // s1 attempt 1

			advance(100);
			expect(handlers.repushHandshake("recipe-app.abc123", "s2")).toBe("pushed"); // s2 attempt 1 (exempt)

			// s1's OWN per-entry window (3000ms since its last push) has cleared, but the team-wide
			// window (3000ms since s2's more recent push) has not - only the team guard explains this.
			advance(2901);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("throttled");

			advance(100);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("pushed"); // s1 attempt 2
		});
	});
});

// resolveLiveIncarnation is the ONE record -> live-socket resolver shared by presence listing, send
// routing, and wake suppression: canonical pane (confirmed-preferred) else the alias liveTeam probe.
describe("resolveLiveIncarnation", () => {
	function mk(confirmed: boolean): import("bun").ServerWebSocket<WsData> {
		const ws = createMockWs();
		ws.data.handshakeConfirmed = confirmed;
		return ws;
	}

	it("returns the canonical pane, preferring a confirmed sub over an unconfirmed one", () => {
		const registry: TeamRegistry = new Map();
		const confirmed = mk(true);
		registry.set(
			"host.abc",
			new Map([
				["s1", mk(false)],
				["s2", confirmed],
			]),
		);
		expect(resolveLiveIncarnation(registry, new SessionStore(), "host.abc")).toBe(confirmed);
	});

	it("falls back to the alias liveTeam socket when no canonical pane is registered", () => {
		const registry: TeamRegistry = new Map();
		const store = new SessionStore();
		store.adoptById("abc", { spawn: "host" });
		store.confirm("host.abc", { team: "host.xyz", subId: "s1" });
		const aliasWs = mk(true);
		registry.set("host.xyz", new Map([["s1", aliasWs]]));
		expect(resolveLiveIncarnation(registry, store, "host.abc")).toBe(aliasWs);
	});

	it("returns undefined when neither the canonical pane nor an alias is live", () => {
		const store = new SessionStore();
		store.adoptById("abc", { spawn: "host" });
		expect(resolveLiveIncarnation(new Map(), store, "host.abc")).toBeUndefined();
	});

	it("a confirmed alias wins over an unconfirmed socket squatting the canonical name", () => {
		const registry: TeamRegistry = new Map();
		const store = new SessionStore();
		store.adoptById("dev", { spawn: "proj-a" });
		store.confirm("proj-a.dev", { team: "proj-a.alias", subId: "s1" });
		const aliasWs = mk(true);
		registry.set("proj-a.alias", new Map([["s1", aliasWs]]));
		registry.set("proj-a.dev", new Map([["evil", mk(false)]]));
		expect(resolveLiveIncarnation(registry, store, "proj-a.dev")).toBe(aliasWs);
	});

	it("returns an unconfirmed canonical socket only when no confirmed lead exists (verifying)", () => {
		const registry: TeamRegistry = new Map();
		const verifying = mk(false);
		registry.set("proj-a.dev", new Map([["s1", verifying]]));
		expect(resolveLiveIncarnation(registry, new SessionStore(), "proj-a.dev")).toBe(verifying);
	});

	it("does not resolve an unconfirmed socket that re-took the alias slot", () => {
		const registry: TeamRegistry = new Map();
		const store = new SessionStore();
		store.adoptById("dev", { spawn: "proj-a" });
		store.confirm("proj-a.dev", { team: "proj-a.alias", subId: "s1" });
		registry.set("proj-a.alias", new Map([["s1", mk(false)]]));
		expect(resolveLiveIncarnation(registry, store, "proj-a.dev")).toBeUndefined();
	});
});
