import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeCoordinator } from "../gateway/wake.js";
import {
	type ConversationRegistry,
	createWebSocketHandlers,
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
		await expect(wake).resolves.toBe(false);
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

	it("a lead confirm binds a preemptive record instead of creating a duplicate (tier 1)", () => {
		const { handlers, sessionStore } = setup();
		// Phone preemptively created the record; the session boots and confirms.
		sessionStore.adoptById("mywork", { spawn: "host", sessionLabel: "My Work" });
		const ws = createMockWs();
		register(handlers, ws, { team: "host.mywork", subId: "s1", claudeSessionId: "tx-9" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });

		expect(sessionStore.size).toBe(1);
		expect(sessionStore.getByTeam("host.mywork")).toMatchObject({
			sessionLabel: "My Work",
			claudeSessionId: "tx-9",
			liveTeam: { team: "host.mywork", subId: "s1" },
		});
	});

	it("a re-incarnation with a matching resume id binds the existing transcript record (tier 2)", () => {
		const { handlers, sessionStore } = setup();
		sessionStore.adoptById("orig", { spawn: "host", sessionLabel: "orig", claudeSessionId: "tx-7" });
		// Manual `claude --resume` re-registers under a fresh self-composed segment carrying the same id.
		const ws = createMockWs();
		register(handlers, ws, { team: "host.fresh1", subId: "s2", claudeSessionId: "tx-7" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });

		expect(sessionStore.size).toBe(1);
		expect(sessionStore.getByTeam("host.orig")?.liveTeam).toEqual({ team: "host.fresh1", subId: "s2" });
		expect(sessionStore.getByTeam("host.fresh1")).toBeUndefined();
	});

	it("a segment colliding with a reserved id mints a fresh record instead (tier 4)", () => {
		const store = new SessionStore({ clash: (id) => id === "evie-bot", idGen: () => "minted1" });
		const { handlers, sessionStore } = setup(store);
		const ws = createMockWs();
		register(handlers, ws, { team: "host.evie-bot", subId: "s1", claudeSessionId: "tx-1", cwdName: "evie-bot" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });

		expect(sessionStore.getByTeam("host.evie-bot")).toBeUndefined();
		expect(sessionStore.getByTeam("host.minted1")).toMatchObject({ id: "minted1", sessionLabel: "evie-bot" });
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

	it("a bare spawn-point team that confirms establishes no record", () => {
		const { handlers, sessionStore } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "someproj", subId: "s1", claudeSessionId: "tx-1" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });
		expect(sessionStore.size).toBe(0);
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
});
