import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { WakeCoordinator } from "../gateway/wake.js";
import { WakeService, type WakeServiceDeps } from "../gateway/wakeService.js";
import type { TeamRegistry, WsData } from "../gateway/websocket.js";
import { processAmbient } from "../shared/ambient.js";
import { SessionStore } from "../shared/session-store.js";

/** The wake orchestration's own contract: join semantics, the fast refusals, mint and rollback. */
describe("WakeService", () => {
	function fakeWs(over: Partial<WsData> = {}) {
		return {
			readyState: 1,
			send: () => {},
			data: { virtual: false, handshakeConfirmed: true, ...over },
		} as unknown as ServerWebSocket<WsData>;
	}

	function setup(over: Partial<WakeServiceDeps> = {}) {
		const sessionStore = new SessionStore({ ambient: processAmbient() });
		const registry: TeamRegistry = new Map();
		const wakeCoordinator = new WakeCoordinator(processAmbient());
		const sent: { team: string; projectPath?: string }[] = [];
		const hostWs = {
			readyState: 1,
			send: (s: string) => void sent.push(JSON.parse(s)),
		} as unknown as ServerWebSocket<WsData>;
		const presenceCalls: string[] = [];
		const forgotten: string[] = [];
		const presence: WakeServiceDeps["presence"] = {
			wakeStart: (t) => void presenceCalls.push(`wakeStart:${t}`),
			wakeEnd: (t) => void presenceCalls.push(`wakeEnd:${t}`),
			createStart: (t) => void presenceCalls.push(`createStart:${t}`),
			createEnd: (t) => void presenceCalls.push(`createEnd:${t}`),
			mintOrReattach: (opts) => sessionStore.mintOrReattach(opts),
			forget: (t) => {
				forgotten.push(t);
				return true;
			},
		};
		const service = new WakeService({
			registry,
			sessionStore,
			presence,
			wakeCoordinator,
			isAvailableProject: (n) => n === "recipe-app",
			knownTeamPaths: new Map([["recipe-app", "/proj/recipe-app"]]),
			offlineCatalog: new Map(),
			liveHostSocket: () => hostWs,
			wakeTimeoutMs: 60,
			...over,
		});
		return { service, sessionStore, registry, wakeCoordinator, sent, presenceCalls, forgotten };
	}

	it("concurrent wakes for one team join a single launch", async () => {
		const s = setup();
		const first = s.service.tryWakeTeam("proj");
		const second = s.service.tryWakeTeam("proj");
		expect(second).toBe(first);
		expect(s.service.isWakeInFlight("proj")).toBe(true);
		expect(s.sent).toHaveLength(1);

		s.wakeCoordinator.notify("proj");
		await expect(first).resolves.toEqual({ ok: true });
		expect(s.service.isWakeInFlight("proj")).toBe(false);
		// One presence announcement per genuine wake, never one per joiner.
		expect(s.presenceCalls).toEqual(["wakeStart:proj", "wakeEnd:proj"]);
	});

	it("refuses a catalog project fast instead of waiting out the timeout", async () => {
		const s = setup();
		await expect(s.service.tryWakeTeam("recipe-app")).resolves.toEqual({ ok: false });
		expect(s.sent).toHaveLength(0);
	});

	it("reports a live incarnation up rather than relaunching over it", async () => {
		const s = setup();
		s.registry.set("proj", new Map([["s1", fakeWs()]]));
		await expect(s.service.tryWakeTeam("proj")).resolves.toEqual({ ok: true });
		expect(s.sent).toHaveLength(0);
	});

	it("never dispatches a wake over the reserved host-daemon pane", async () => {
		const s = setup();
		await expect(s.service.tryWakeTeam("host.host-daemon")).resolves.toEqual({ ok: false });
		expect(s.sent).toHaveLength(0);
	});

	it("a recordless composite refuses to adopt the typed name, before the host check", async () => {
		const s = setup({ liveHostSocket: () => undefined });
		const result = await s.service.tryWakeTeam("proj.story");
		// The more actionable refusal wins over "disconnected": the send was doomed either way.
		expect(result).toEqual({
			ok: false,
			error: `"proj.story" does not exist yet; retry with a displayLabel to create it`,
		});
	});

	it("a disconnected host answers disconnected instead of holding the timeout", async () => {
		const s = setup({ liveHostSocket: () => undefined });
		await expect(s.service.tryWakeTeam("proj")).resolves.toEqual({ ok: false, errorKind: "disconnected" });
	});

	it("a displayLabel mints an opaque id and the caller learns the real address", async () => {
		const s = setup();
		const wake = s.service.tryWakeTeam("proj.story", { displayLabel: "Story Time" });
		expect(s.sent).toHaveLength(1);
		const launched = s.sent[0].team;
		// The typed segment is never adopted; the launch targets the minted opaque id.
		expect(launched).not.toBe("proj.story");
		expect(launched.startsWith("proj.")).toBe(true);

		s.wakeCoordinator.notify(launched);
		await expect(wake).resolves.toEqual({ ok: true, resolvedTeam: launched });
		expect(s.forgotten).toHaveLength(0);
	});

	it("rolls back the provisional record when the minted launch never comes online", async () => {
		const s = setup();
		const wake = s.service.tryWakeTeam("proj.story", { displayLabel: "Story Time" });
		const launched = s.sent[0].team;
		// Nobody notifies; the 60ms coordinator hold elapses.
		const result = await wake;
		expect(result.ok).toBe(false);
		expect(s.forgotten).toEqual([launched]);
	});

	it("markCreateInFlight covers the relayToHost branch until its cleanup runs", () => {
		const s = setup();
		const done = s.service.markCreateInFlight("proj.new");
		expect(s.service.isWakeInFlight("proj.new")).toBe(true);
		done();
		expect(s.service.isWakeInFlight("proj.new")).toBe(false);
		expect(s.presenceCalls).toEqual(["createStart:proj.new", "createEnd:proj.new"]);
	});
});
