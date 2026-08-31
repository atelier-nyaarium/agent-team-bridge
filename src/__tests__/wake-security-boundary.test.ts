import type { ServerWebSocket } from "bun";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectPredicates } from "../gateway/index.js";
import { WakeCoordinator } from "../gateway/wake.js";
import { WakeService } from "../gateway/wakeService.js";
import { createWebSocketHandlers, type TeamRegistry, type WsData } from "../gateway/websocket.js";
import { SessionStore } from "../shared/session-store.js";
import { createMockWs } from "./helpers/websocket.js";

const HOST_TOKEN = "host-secret";

describe("wake security boundary", () => {
	const intervals: ReturnType<typeof setInterval>[] = [];

	afterEach(() => {
		for (const interval of intervals) clearInterval(interval);
		intervals.length = 0;
	});

	function setup() {
		const knownTeamPaths = new Map<string, string>();
		const offlineCatalog = new Map<string, string>();
		const registry: TeamRegistry = new Map();
		const conversationRegistry = new Map();
		const wakeCoordinator = new WakeCoordinator();
		const predicates = createProjectPredicates(offlineCatalog, knownTeamPaths);
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry,
			knownTeamPaths,
			offlineCatalog,
			wakeCoordinator,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2, hostWsToken: HOST_TOKEN },
		});
		intervals.push(handlers.heartbeatInterval);
		return { knownTeamPaths, offlineCatalog, registry, handlers, wakeCoordinator, ...predicates };
	}

	function register(
		handlers: ReturnType<typeof createWebSocketHandlers>,
		team: string,
		projectPath: string,
	): ServerWebSocket<WsData> {
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(
			ws,
			JSON.stringify({
				type: "register",
				team,
				subId: `${team}-sub`,
				projectPath,
				...(team === "host" ? { token: HOST_TOKEN } : {}),
			}),
		);
		return ws;
	}

	function wakeService(s: ReturnType<typeof setup>, hostWs: ServerWebSocket<WsData>) {
		const sessionStore = new SessionStore();
		return new WakeService({
			registry: s.registry,
			sessionStore,
			presence: {
				wakeStart: () => {},
				wakeEnd: () => {},
				createStart: () => {},
				createEnd: () => {},
				mintOrReattach: (opts) => sessionStore.mintOrReattach(opts),
				forget: () => true,
			},
			wakeCoordinator: s.wakeCoordinator,
			isAvailableProject: s.isAvailableProject,
			knownTeamPaths: s.knownTeamPaths,
			offlineCatalog: s.offlineCatalog,
			liveHostSocket: () => hostWs,
			wakeTimeoutMs: 100,
		});
	}

	it("does not reserve a discovery-only name as a session id", () => {
		const s = setup();
		register(s.handlers, "discovery-only", "/attacker/path");
		const sessionStore = new SessionStore({
			idGen: () => "discovery-only",
			clash: s.isTrustedCatalogProject,
		});

		expect(sessionStore.mint({ spawn: "project" }).id).toBe("discovery-only");
	});

	it("blocks a composite wake when its registered project segment is available", async () => {
		const s = setup();
		register(s.handlers, "evil", "/attacker/path");
		const hostWs = createMockWs();
		const service = wakeService(s, hostWs);

		await expect(service.tryWakeTeam("evil.session")).resolves.toEqual({ ok: false });
		expect(hostWs.send).not.toHaveBeenCalled();
	});

	it("uses the trusted catalog path after a register supplied a competing path", async () => {
		const s = setup();
		register(s.handlers, "project", "/attacker/path");
		const sent: string[] = [];
		const hostWs = { readyState: 1, send: (value: string) => sent.push(value) } as ServerWebSocket<WsData>;
		register(s.handlers, "host", "");
		s.handlers.message(
			s.registry.get("host")!.get("host-sub")!,
			JSON.stringify({ type: "catalog", projects: [{ team: "project", projectPath: "/trusted/path" }] }),
		);
		const service = wakeService(s, hostWs);
		const wake = service.tryWakeTeam("project.session", { displayLabel: "Session" });
		const message = JSON.parse(sent[0]!);
		s.wakeCoordinator.notify(message.team);

		await expect(wake).resolves.toMatchObject({ ok: true });
		expect(message.projectPath).toBe("/trusted/path");
	});
});
