import { afterEach, describe, expect, it, vi } from "vitest";
import { POST_WAKE_SETTLE_MS } from "../gateway/routes.js";
import { WakeCoordinator } from "../gateway/wake.js";
import {
	type ConversationRegistry,
	createWebSocketHandlers,
	HANDSHAKE_REPUSH_DEDUPE_MS,
	resolveLiveIncarnation,
	type TeamRegistry,
} from "../gateway/websocket.js";
import { HANDSHAKE_PENDING_TTL_MS } from "../gateway/wsTypes.js";
import { SessionStore } from "../shared/session-store.js";
import { authFor, createMockWs, handshakeIdFrom, handshakePushCount } from "./helpers/websocket.js";

// The handshake confirm is the ceremony that establishes a durable session record: register only
// stashes the reported ids, the confirm binds/creates and stamps liveTeam. These pin the binding
// order, the register-time no-write, the readyState gate, and full socket eviction cleanup.
describe("handshake-established session records", () => {
	let intervals: ReturnType<typeof setInterval>[] = [];
	afterEach(() => {
		for (const id of intervals) clearInterval(id);
		intervals = [];
	});

	function setup(sessionStore = new SessionStore(), now?: () => number, withoutStore = false) {
		const configuredStore = withoutStore ? undefined : sessionStore;
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
			knownTeamPaths: new Map(),
			offlineCatalog: new Map(),
			wakeCoordinator: new WakeCoordinator(),
			sessionStore: configuredStore,
			auth: authFor(registry, configuredStore),
			now,
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

	it("register announces the presence plane dirty immediately, even before the handshake resolves either way", () => {
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const announcePresenceDirty = vi.fn();
		const handlers = createWebSocketHandlers({
			registry,
			conversationRegistry,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
			knownTeamPaths: new Map(),
			offlineCatalog: new Map(),
			wakeCoordinator: new WakeCoordinator(),
			sessionStore: new SessionStore(),
			announcePresenceDirty,
		});
		intervals.push(handlers.heartbeatInterval);
		const ws = createMockWs();
		expect(announcePresenceDirty).not.toHaveBeenCalled();
		register(handlers, ws, { team: "host.abc123", subId: "s1", claudeSessionId: "tx-1", cwdName: "switchboard" });
		// The row is already live in the raw registry at this point (resolveLiveIncarnation reads it
		// directly) - a caller polling right now must see the plane recompute, not wait for the
		// eventual handshake confirm (which may be seconds away) or the periodic tripwire.
		expect(announcePresenceDirty).toHaveBeenCalledTimes(1);
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

	it("a DIFFERENT team presenting a known conversationId is refused - it can neither evict nor steal that slot", () => {
		const { handlers, sessionStore, conversationRegistry } = setup();
		const victim = createMockWs();
		register(handlers, victim, {
			team: "host.victim-team",
			subId: "s1",
			conversationId: "conv-shared",
			claudeSessionId: "tx-1",
		});
		handlers.resolveHandshake(handshakeIdFrom(victim), { isMainOrLead: true });
		expect(sessionStore.getByTeam("host.victim-team")?.liveTeam).toEqual({ team: "host.victim-team", subId: "s1" });

		// conversationId rides verbatim in every session_id a caller has seen, so it is not a secret
		// - a connection that merely learned it, under an unrelated team, must not be able to evict
		// the real holder's live socket or steal its conversationRegistry slot.
		const attacker = createMockWs();
		register(handlers, attacker, { team: "host.attacker-team", subId: "s1", conversationId: "conv-shared" });

		expect(victim.close).not.toHaveBeenCalled();
		expect(sessionStore.getByTeam("host.victim-team")?.liveTeam).toEqual({ team: "host.victim-team", subId: "s1" });
		expect(conversationRegistry.get("conv-shared")).toBe(victim);
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

		expect(ws2.close).toHaveBeenCalled();
		expect(ws2.data.handshakeConfirmed).toBe(false);
		expect(sessionStore.getByTeam("host.def")).toBeUndefined();
		expect(sessionStore.getByTeam("host.abc")?.liveTeam).toEqual({ team: "host.abc", subId: "s1" });
		expect(sessionStore.size).toBe(1);
	});

	it("hands over a transcript when its prior socket is gone", () => {
		const { handlers, sessionStore } = setup();
		const ws1 = createMockWs();
		register(handlers, ws1, { team: "host.abc", subId: "s1", claudeSessionId: "tx-1" });
		handlers.resolveHandshake(handshakeIdFrom(ws1), { isMainOrLead: true });
		handlers.close(ws1);

		const ws2 = createMockWs();
		register(handlers, ws2, { team: "host.def", subId: "s2", claudeSessionId: "tx-1" });
		handlers.resolveHandshake(handshakeIdFrom(ws2), { isMainOrLead: true });

		expect(ws2.close).not.toHaveBeenCalled();
		expect(ws2.data.handshakeConfirmed).toBe(true);
		expect(sessionStore.getByTeam("host.def")?.liveTeam).toEqual({ team: "host.def", subId: "s2" });
		expect(sessionStore.getByTeam("host.abc")?.liveTeam).toBeUndefined();
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

	it("expires and evicts an unanswered handshake at its deadline", () => {
		let now = 0;
		const { handlers } = setup(new SessionStore({ now: () => now }), () => now);
		const ws = createMockWs();
		register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
		now = HANDSHAKE_PENDING_TTL_MS;
		handlers.heartbeatTick();
		expect(ws.close).toHaveBeenCalled();
		expect(handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true })).toBe(false);
		expect(ws.data.handshakeConfirmed).toBe(false);
	});

	it("peer pong keeps a connected confirmed record from TTL sweep", () => {
		let clock = 0;
		const sessionStore = new SessionStore({ now: () => clock });
		const { handlers } = setup(sessionStore);
		const ws = createMockWs();
		register(handlers, ws, { team: "host.abc", subId: "s1", claudeSessionId: "tx-1" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });
		clock = 100;
		handlers.pong(ws);

		expect(sessionStore.sweep(50)).toEqual([]);
	});

	it("does not evict a valid client when recording is disabled", () => {
		const { handlers } = setup(undefined, undefined, true);
		const ws = createMockWs();
		register(handlers, ws, { team: "host.abc123", subId: "s1" });
		handlers.resolveHandshake(handshakeIdFrom(ws), { isMainOrLead: true });

		expect(ws.close).not.toHaveBeenCalled();
		expect(ws.data.handshakeConfirmed).toBe(true);
	});

	it("does not confirm or evict on garbage handshake prose", () => {
		const { handlers, sessionStore } = setup();
		const ws = createMockWs();
		register(handlers, ws, { team: "recipe-app.abc123", subId: "s1" });
		expect(handlers.resolveHandshake(handshakeIdFrom(ws), undefined, "I am definitely the lead")).toBe(true);
		expect(ws.data.handshakeConfirmed).toBe(false);
		expect(ws.close).not.toHaveBeenCalled();
		expect(sessionStore.size).toBe(0);
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
		// A wake mints the handshake at register, then the send path waits POST_WAKE_SETTLE_MS and
		// delivers - and that delivery re-pushes the handshake of any still-unconfirmed recipient. So
		// the dedupe window has to outlast the settle, or every wake-then-deliver duplicates the
		// handshake. These were both 3000ms once, which made the nudge land ~1ms after the window
		// opened and duplicated it every single time, so the coupling is asserted rather than trusted.
		it("dedupe window outlasts the post-wake settle delay, so a wake cannot duplicate its own handshake", () => {
			expect(HANDSHAKE_REPUSH_DEDUPE_MS).toBeGreaterThan(POST_WAKE_SETTLE_MS);
		});

		// Fakes ONLY Date (repushHandshake's guards read Date.now()), leaving setInterval/clearInterval
		// real so the outer describe's heartbeatInterval tracking/cleanup is unaffected.
		afterEach(() => {
			vi.useRealTimers();
		});

		/** Move the faked clock forward by ms. */
		function advance(ms: number): void {
			vi.setSystemTime(Date.now() + ms);
		}

		/** Step just past the dedupe window. Derived from the constant, never a literal, so changing
		 * the window cannot silently turn these assertions into tests of the wrong thing. */
		function pastWindow(): void {
			advance(HANDSHAKE_REPUSH_DEDUPE_MS + 1);
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

			pastWindow();
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

			pastWindow();
			handlers.repushHandshake("recipe-app.abc123", "s1");
			pastWindow();
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
				pastWindow();
				expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("pushed");
			}
			expect(handshakePushCount(ws)).toBe(6); // 1 mint + 5 repushes

			pastWindow();
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

			pastWindow();
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

			pastWindow();
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

			pastWindow();
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

			pastWindow();
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("pushed"); // s1 attempt 1

			advance(100);
			expect(handlers.repushHandshake("recipe-app.abc123", "s2")).toBe("pushed"); // s2 attempt 1 (exempt)

			// s1's OWN per-entry window has cleared, but the team-wide window (measured from s2's more
			// recent push, 100ms later) has not - only the team guard explains this.
			advance(HANDSHAKE_REPUSH_DEDUPE_MS - 99);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("throttled");

			advance(100);
			expect(handlers.repushHandshake("recipe-app.abc123", "s1")).toBe("pushed"); // s1 attempt 2
		});
	});
});
