import { afterEach, describe, expect, it, type vi } from "vitest";
import { presentedByRegister } from "../gateway/sessionAuthority.js";
import { WakeCoordinator } from "../gateway/wake.js";
import { type ConversationRegistry, createWebSocketHandlers, type TeamRegistry } from "../gateway/websocket.js";
import { SessionStore } from "../shared/session-store.js";
import { authFor, createMockWs, handshakeIdFrom } from "./helpers/websocket.js";

// The session binding is what stops a compromised container from speaking as a sibling: the token
// reaches a session only through the daemon's launch command, so presenting the one bound to a name
// is what proves ownership of it. These pin the gate AND the two paths that must stay open for a
// DEVCONTAINER session, since a gate that locks out a hand-launched one or a purged gateway would be
// worked around instead. A session on a host shell is the deliberate exception, below.
describe("session binding on register", () => {
	let intervals: ReturnType<typeof setInterval>[] = [];
	afterEach(() => {
		for (const id of intervals) clearInterval(id);
		intervals = [];
	});

	function setup(sessionStore: SessionStore) {
		const registry: TeamRegistry = new Map();
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry: new Map() as ConversationRegistry,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
			knownTeamPaths: new Map(),
			offlineCatalog: new Map(),
			wakeCoordinator: new WakeCoordinator(),
			sessionStore,
			auth: authFor(registry, sessionStore),
		});
		intervals.push(handlers.heartbeatInterval);
		return { handlers, registry };
	}

	function register(
		handlers: ReturnType<typeof setup>["handlers"],
		ws: ReturnType<typeof createMockWs>,
		msg: object,
	) {
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", mode: "channel", ...msg }));
	}

	function rejections(ws: ReturnType<typeof createMockWs>): unknown[] {
		return (ws.send as ReturnType<typeof vi.fn>).mock.calls
			.map((c) => JSON.parse(c[0] as string))
			.filter((m) => m.type === "register_reject");
	}

	it("refuses a neighbour claiming a launched session's name once that session has used its binding", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		const token = store.ensureBindToken(record);
		const team = `recipe-app.${record.id}`;
		const { handlers, registry } = setup(store);

		register(handlers, createMockWs(), { team, subId: "s1", sessionToken: token });
		const impostor = createMockWs();
		register(handlers, impostor, { team, subId: "s2" });

		expect(rejections(impostor)).toHaveLength(1);
		expect(registry.get(team)?.has("s2")).toBe(false);
	});

	it("leaves a binding inert until it is presented, so a launch that only reattached cannot lock its own session out", () => {
		// A reattach discards the launch command, token export included, so the running session never
		// receives the token the gateway minted for it.
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		store.ensureBindToken(record);
		const team = `recipe-app.${record.id}`;
		const { handlers, registry } = setup(store);

		const live = createMockWs();
		register(handlers, live, { team, subId: "s1" });

		expect(rejections(live)).toHaveLength(0);
		expect(registry.get(team)?.has("s1")).toBe(true);
	});

	it("admits the session holding the binding", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		const token = store.ensureBindToken(record);
		const team = `recipe-app.${record.id}`;
		const { handlers, registry } = setup(store);

		const real = createMockWs();
		register(handlers, real, { team, subId: "s1", sessionToken: token });

		expect(rejections(real)).toHaveLength(0);
		expect(registry.get(team)?.has("s1")).toBe(true);
	});

	it("refuses a token minted for a different session, so one container cannot borrow another's", () => {
		const store = new SessionStore();
		const mine = store.mint({ spawn: "recipe-app" });
		const victim = store.mint({ spawn: "recipe-app" });
		const myToken = store.ensureBindToken(mine);
		const victimToken = store.ensureBindToken(victim);
		const victimTeam = `recipe-app.${victim.id}`;
		const { handlers } = setup(store);

		register(handlers, createMockWs(), { team: victimTeam, subId: "s1", sessionToken: victimToken });
		const ws = createMockWs();
		register(handlers, ws, { team: victimTeam, subId: "s2", sessionToken: myToken });

		expect(rejections(ws)).toHaveLength(1);
	});

	it("still admits a hand-launched session, whose record was never given a binding to present", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		const team = `recipe-app.${record.id}`;
		const { handlers, registry } = setup(store);

		const ws = createMockWs();
		register(handlers, ws, { team, subId: "s1" });

		expect(rejections(ws)).toHaveLength(0);
		expect(registry.get(team)?.has("s1")).toBe(true);
	});

	it("still admits every live session after the store is purged, rather than bricking the fleet", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		const token = store.ensureBindToken(record);
		const team = `recipe-app.${record.id}`;
		const { handlers, registry } = setup(new SessionStore());

		const ws = createMockWs();
		register(handlers, ws, { team, subId: "s1", sessionToken: token });

		expect(rejections(ws)).toHaveLength(0);
		expect(registry.get(team)?.has("s1")).toBe(true);
	});
});

// Answering someone else's handshake with isMainOrLead:false evicts their socket, and their MCP
// then stops reconnecting - a permanent remote kill from a single forged reply. Only the challenged
// session may answer, proven by the binding it alone was launched with.
describe("handshake answer ownership", () => {
	let intervals: ReturnType<typeof setInterval>[] = [];
	afterEach(() => {
		for (const id of intervals) clearInterval(id);
		intervals = [];
	});

	function arm(store: SessionStore, team: string, token?: string) {
		const registry: TeamRegistry = new Map();
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry: new Map() as ConversationRegistry,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
			knownTeamPaths: new Map(),
			offlineCatalog: new Map(),
			wakeCoordinator: new WakeCoordinator(),
			sessionStore: store,
			auth: authFor(registry, store),
		});
		intervals.push(handlers.heartbeatInterval);
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(
			ws,
			JSON.stringify({
				type: "register",
				mode: "channel",
				team,
				subId: "s1",
				...(token ? { sessionToken: token } : {}),
			}),
		);
		return { handlers, ws };
	}

	it("ignores a worker-reject from someone who does not hold the session's binding, leaving it answerable", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		const token = store.ensureBindToken(record);
		const team = `recipe-app.${record.id}`;
		const { handlers, ws } = arm(store, team, token);
		const hsId = handshakeIdFrom(ws);

		expect(handlers.resolveHandshake(hsId, { isMainOrLead: false })).toBe(true);
		expect(ws.close).not.toHaveBeenCalled();

		// The real session can still answer, so the spoof consumed nothing.
		expect(
			handlers.resolveHandshake(
				hsId,
				{ isMainOrLead: true },
				undefined,
				presentedByRegister({ sessionToken: token }),
			),
		).toBe(true);
		expect(store.getByTeam(team)?.liveTeam).toEqual({ team, subId: "s1" });
	});

	it("lets an unbound session answer its own handshake, since nothing ever handed it a binding", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		const team = `recipe-app.${record.id}`;
		const { handlers, ws } = arm(store, team);

		expect(handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true })).toBe(true);
		expect(store.getByTeam(team)?.liveTeam).toEqual({ team, subId: "s1" });
	});
});

// An inert binding must be invisible to every gate, not just the register one: a token minted for a
// launch that only reattached was never delivered, so demanding it anywhere strands the real session.
describe("inert bindings stay out of the way", () => {
	let intervals: ReturnType<typeof setInterval>[] = [];
	afterEach(() => {
		for (const id of intervals) clearInterval(id);
		intervals = [];
	});

	function setup(sessionStore: SessionStore) {
		const registry: TeamRegistry = new Map();
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry: new Map() as ConversationRegistry,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
			knownTeamPaths: new Map(),
			offlineCatalog: new Map(),
			wakeCoordinator: new WakeCoordinator(),
			sessionStore,
			auth: authFor(registry, sessionStore),
		});
		intervals.push(handlers.heartbeatInterval);
		return { handlers, registry };
	}

	it("lets a session whose token was never delivered confirm its own handshake", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		store.ensureBindToken(record);
		const team = store.teamOf(record);
		const { handlers } = setup(store);

		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", mode: "channel", team, subId: "s1" }));
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });

		expect(store.getByTeam(team)?.liveTeam).toEqual({ team, subId: "s1" });
	});

	it("expels a squatter that claimed the name before the binding armed, so claiming first wins nothing", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		const token = store.ensureBindToken(record);
		const team = store.teamOf(record);
		const { handlers, registry } = setup(store);

		const squatter = createMockWs();
		handlers.open(squatter);
		handlers.message(squatter, JSON.stringify({ type: "register", mode: "channel", team, subId: "s1" }));

		const real = createMockWs();
		handlers.open(real);
		handlers.message(
			real,
			JSON.stringify({ type: "register", mode: "channel", team, subId: "s2", sessionToken: token }),
		);

		expect(squatter.close).toHaveBeenCalled();
		expect(registry.get(team)?.has("s1")).toBe(false);
		expect(registry.get(team)?.has("s2")).toBe(true);
	});
});

// A session on a host SHELL is the one name that routes a wake at the real machine rather than a
// container, so it alone must prove the daemon launched it. An unclaimed name is otherwise claimable
// by anyone, which is what let a stranger have Claude started on the host.
describe("host-shell sessions must present a daemon launch token", () => {
	let intervals: ReturnType<typeof setInterval>[] = [];
	afterEach(() => {
		for (const id of intervals) clearInterval(id);
		intervals = [];
	});

	function setup(sessionStore: SessionStore) {
		const registry: TeamRegistry = new Map();
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry: new Map() as ConversationRegistry,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
			knownTeamPaths: new Map(),
			offlineCatalog: new Map(),
			wakeCoordinator: new WakeCoordinator(),
			sessionStore,
			auth: authFor(registry, sessionStore),
		});
		intervals.push(handlers.heartbeatInterval);
		return { handlers, registry };
	}

	function tryRegister(store: SessionStore, team: string, sessionToken?: string) {
		const { handlers, registry } = setup(store);
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(
			ws,
			JSON.stringify({
				type: "register",
				mode: "channel",
				team,
				subId: "s1",
				...(sessionToken ? { sessionToken } : {}),
			}),
		);
		return { ws, admitted: registry.get(team)?.has("s1") === true };
	}

	for (const spawn of ["host", "windows"]) {
		it(`refuses an unclaimed ${spawn}.* name, which no daemon ever launched`, () => {
			const { ws, admitted } = tryRegister(new SessionStore(), `${spawn}.squatter`);

			expect(admitted).toBe(false);
			expect(ws.close).toHaveBeenCalled();
		});
	}

	it("admits a host session presenting its own token on its FIRST register, before the binding arms", () => {
		// The regression this gate invites: a fresh daemon launch HAS a record and a token, but its
		// binding is inert until this very register activates it. A rule reading the binding instead of
		// the token would refuse every real host session on connect.
		const store = new SessionStore();
		const record = store.mint({ spawn: "host" });
		const token = store.ensureBindToken(record);
		expect(store.isBindingActive(record)).toBe(false);

		const { admitted } = tryRegister(store, store.teamOf(record), token);

		expect(admitted).toBe(true);
	});

	it("refuses a host name presented with another session's token", () => {
		const store = new SessionStore();
		const mine = store.mint({ spawn: "host" });
		const theirs = store.mint({ spawn: "host" });
		const borrowed = store.ensureBindToken(theirs);

		const { admitted } = tryRegister(store, store.teamOf(mine), borrowed);

		expect(admitted).toBe(false);
	});

	it("leaves an unclaimed devcontainer name claimable, so only host shells tightened", () => {
		const { admitted } = tryRegister(new SessionStore(), "recipe-app.abc123");

		expect(admitted).toBe(true);
	});
});
