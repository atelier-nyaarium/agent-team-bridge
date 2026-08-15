import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeCoordinator } from "../gateway/wake.js";
import { type ConversationRegistry, createWebSocketHandlers, type TeamRegistry } from "../gateway/websocket.js";
import { createMockWs } from "./helpers/websocket.js";

const HOST_TOKEN = "host-secret";

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
			onDaemonCapabilities?: (capabilities: { id: string; instructions?: string }[]) => void;
			hostOpCoordinator?: { settle: ReturnType<typeof vi.fn>; failAll: ReturnType<typeof vi.fn> };
			onPresenceDerive?: (
				team: string,
				derived:
					| { working?: boolean; needsLogin?: boolean; limitBlocked?: boolean; limitDetail?: string }
					| undefined,
			) => void;
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
			onPresenceDerive: overrides.onPresenceDerive,
			onDaemonCapabilities: overrides.onDaemonCapabilities,
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

	it("takes a capability declaration from the authenticated daemon", () => {
		const onDaemonCapabilities = vi.fn();
		const { handlers } = setup({ onDaemonCapabilities });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(
			ws,
			JSON.stringify({
				type: "register",
				team: "host",
				subId: "h1",
				token: HOST_TOKEN,
				daemonCapabilities: [{ id: "codex-agent", instructions: "Delegate like so." }],
			}),
		);
		expect(onDaemonCapabilities).toHaveBeenCalledWith([{ id: "codex-agent", instructions: "Delegate like so." }]);
	});

	it("takes an empty declaration, which is how a daemon says the feature went off", () => {
		const onDaemonCapabilities = vi.fn();
		const { handlers } = setup({ onDaemonCapabilities });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(
			ws,
			JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN, daemonCapabilities: [] }),
		);
		expect(onDaemonCapabilities).toHaveBeenCalledWith([]);
	});

	it("leaves the last declaration standing when a register carries none", () => {
		const onDaemonCapabilities = vi.fn();
		const { handlers } = setup({ onDaemonCapabilities });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		expect(onDaemonCapabilities).not.toHaveBeenCalled();
	});

	it("does not let a refused second daemon replace the live declaration on its way out", () => {
		const onDaemonCapabilities = vi.fn();
		const { handlers } = setup({ onDaemonCapabilities });
		const live = createMockWs();
		const second = createMockWs();
		handlers.open(live);
		handlers.open(second);

		const withCodex = {
			type: "register",
			team: "host",
			subId: "h1",
			token: HOST_TOKEN,
			daemonCapabilities: [{ id: "codex-agent" }],
		};
		handlers.message(live, JSON.stringify(withCodex));
		handlers.message(
			second,
			JSON.stringify({ type: "register", team: "host", subId: "h2", token: HOST_TOKEN, daemonCapabilities: [] }),
		);

		expect(second.close).toHaveBeenCalled();
		expect(onDaemonCapabilities).toHaveBeenCalledTimes(1);
		expect(onDaemonCapabilities).toHaveBeenCalledWith([{ id: "codex-agent" }]);
	});

	it("ignores a capability declaration from anyone but the host slot", () => {
		const onDaemonCapabilities = vi.fn();
		const { handlers } = setup({ onDaemonCapabilities });
		const rogue = createMockWs();
		const badToken = createMockWs();
		handlers.open(rogue);
		handlers.open(badToken);
		const declaration = [{ id: "codex-agent" }];

		handlers.message(
			rogue,
			JSON.stringify({ type: "register", team: "myproject", subId: "r1", daemonCapabilities: declaration }),
		);
		handlers.message(
			badToken,
			JSON.stringify({
				type: "register",
				team: "host",
				subId: "h1",
				token: "wrong",
				daemonCapabilities: declaration,
			}),
		);

		expect(onDaemonCapabilities).not.toHaveBeenCalled();
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

	it("a presence_derive from the host socket reports the confirmed working/needsLogin", () => {
		const onPresenceDerive = vi.fn();
		const { handlers } = setup({ onPresenceDerive });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		handlers.message(
			ws,
			JSON.stringify({ type: "presence_derive", team: "proj-a.main", working: true, needsLogin: false }),
		);
		expect(onPresenceDerive).toHaveBeenCalledWith("proj-a.main", {
			working: true,
			needsLogin: false,
			limitBlocked: undefined,
			limitDetail: undefined,
		});
	});

	it("a presence_derive carries the usage-limit block and its reset text", () => {
		const onPresenceDerive = vi.fn();
		const { handlers } = setup({ onPresenceDerive });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		handlers.message(
			ws,
			JSON.stringify({
				type: "presence_derive",
				team: "proj-a.main",
				working: false,
				needsLogin: false,
				limitBlocked: true,
				limitDetail: "resets 5pm",
			}),
		);
		expect(onPresenceDerive).toHaveBeenCalledWith("proj-a.main", {
			working: false,
			needsLogin: false,
			limitBlocked: true,
			limitDetail: "resets 5pm",
		});
	});

	it("a presence_derive with no derived field at all passes undefined (a derivation-impossible clear)", () => {
		const onPresenceDerive = vi.fn();
		const { handlers } = setup({ onPresenceDerive });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "host", subId: "h1", token: HOST_TOKEN }));
		handlers.message(ws, JSON.stringify({ type: "presence_derive", team: "proj-a.main" }));
		expect(onPresenceDerive).toHaveBeenCalledWith("proj-a.main", undefined);
	});

	it("a presence_derive from a NON-host socket is ignored", () => {
		const onPresenceDerive = vi.fn();
		const { handlers } = setup({ onPresenceDerive });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha", subId: "s1" }));
		handlers.message(
			ws,
			JSON.stringify({ type: "presence_derive", team: "proj-a.main", working: true, needsLogin: false }),
		);
		expect(onPresenceDerive).not.toHaveBeenCalled();
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
