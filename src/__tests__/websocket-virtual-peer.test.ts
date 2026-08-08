import { afterEach, describe, expect, it } from "vitest";
import { WakeCoordinator } from "../gateway/wake.js";
import { type ConversationRegistry, createWebSocketHandlers, type TeamRegistry } from "../gateway/websocket.js";
import { createMockWs } from "./helpers/websocket.js";

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
