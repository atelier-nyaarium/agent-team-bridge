import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeCoordinator } from "../gateway/wake.js";
import {
	type ConversationRegistry,
	createWebSocketHandlers,
	type TeamRegistry,
	type WsData,
} from "../gateway/websocket.js";

function createMockWs() {
	return {
		data: { teamName: null, subId: "", conversationId: null, missedPings: 0, isStale: false } as WsData,
		readyState: 1,
		close: vi.fn(),
		ping: vi.fn(),
		send: vi.fn(),
	} as unknown as import("bun").ServerWebSocket<WsData>;
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
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2, hostWsToken: overrides.hostWsToken },
			knownTeamPaths,
			offlineCatalog,
			wakeCoordinator,
			hostOpCoordinator: overrides.hostOpCoordinator as
				| {
						settle: (reqId: string, result: { ok: boolean; result?: unknown; error?: string }) => void;
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
		handlers.message(ws1, JSON.stringify({ type: "register", team: "host", subId: "a1" }));
		handlers.message(ws2, JSON.stringify({ type: "register", team: "host", subId: "a2" }));
		const subs = registry.get("host");
		expect(subs!.size).toBe(1);
		expect(subs!.get("a1")).toBe(ws1);
		expect(ws2.close).toHaveBeenCalled();
	});

	it("with a host token set, a host register with a wrong/missing token is rejected", () => {
		const { handlers, registry } = setup({ hostWsToken: "secret" });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1" }));
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

	it("with NO host token set, a token-less host register still succeeds (coexistence)", () => {
		const { handlers, registry } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1" }));
		expect(registry.get("host")?.get("h1")).toBe(ws);
	});

	it("a host_op_reply from the host socket settles the coordinator by reqId", () => {
		const hostOpCoordinator = { settle: vi.fn(), failAll: vi.fn() };
		const { handlers } = setup({ hostOpCoordinator });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1" }));
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
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1" }));
		handlers.close(ws);
		expect(hostOpCoordinator.failAll).toHaveBeenCalledWith("host daemon disconnected");
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
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1" }));
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
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1" }));
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
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1" }));
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
		handlers.message(real, JSON.stringify({ type: "register", team: "teamx", subId: "r1", mode: "cli" }));

		// Virtual sub lands beside the real one after registration.
		const subs = registry.get("teamx");
		subs?.set("conv-1", createVirtualWs("teamx", "conv-1"));

		handlers.close(real);

		// Virtual sub keeps the entry alive; the real sub's slot is cleaned up.
		expect(registry.get("teamx")?.size).toBe(1);
		expect(registry.get("teamx")?.has("conv-1")).toBe(true);
	});
});
