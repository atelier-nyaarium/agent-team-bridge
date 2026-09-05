import { describe, expect, it } from "vitest";
import { createSessionRegistryReporter, SESSION_REGISTRY_RETRY_MS } from "../gateway/router/sessionRegistryReporter.js";
import { processAmbient } from "../shared/ambient.js";
import { SessionStore } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

describe("session registry reporter", () => {
	it("reports a minted session once", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		store.mint({ spawn: "host", sessionLabel: "Work" });
		await flush();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ action: "session_upsert", params: { sessionId: "host.one", label: "Work" } });
	});

	it("reports a swept session by its spawn id", async () => {
		let now = 100;
		const store = new SessionStore({ ambient: { now: () => now }, idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		store.mint({ spawn: "host" });
		now = 200;
		store.sweep(50);
		await flush();

		expect(sent.at(-1)).toMatchObject({ action: "session_forget", params: { sessionId: "host.one" } });
	});

	it("reports a forgotten session after reconnecting", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		let incarnation: number | null = 3;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => incarnation,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		const record = store.mint({ spawn: "host" });
		await flush();
		incarnation = null;
		store.forget(store.teamOf(record));
		incarnation = 4;
		reporter.reconcile();
		await flush();

		expect(sent.filter((entry) => entry.action === "session_forget")).toHaveLength(1);
	});

	it("retries a rejected tombstone", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: string[] = [];
		let incarnation: number | null = 3;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action) => {
				sent.push(action);
				return { result: { ok: false, error: "x" } };
			},
			incarnation: () => incarnation,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		incarnation = null;
		const record = store.mint({ spawn: "host" });
		store.forget(store.teamOf(record));
		incarnation = 4;
		reporter.reconcile();
		await flush();
		reporter.reconcile();
		await flush();

		expect(sent.filter((action) => action === "session_forget")).toHaveLength(2);
	});

	it("cancels a pending tombstone when the session is recreated", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		let incarnation: number | null = 3;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => {
				sent.push({ action, params });
				return { result: { ok: true } };
			},
			incarnation: () => incarnation,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		incarnation = null;
		const record = store.mint({ spawn: "host" });
		store.forget(store.teamOf(record));
		store.mint({ spawn: "host" });
		incarnation = 4;
		reporter.reconcile();
		await flush();

		expect(sent.filter((entry) => entry.action === "session_upsert")).toHaveLength(1);
		expect(sent.filter((entry) => entry.action === "session_forget")).toHaveLength(0);
	});

	it("reconcile reports records that vanished", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		const record = store.mint({ spawn: "host" });
		reporter.reconcile();
		store.forget(store.teamOf(record));
		reporter.reconcile();
		await flush();

		expect(sent.at(-1)).toMatchObject({ action: "session_forget", params: { sessionId: "host.one" } });
	});

	it("defers the baseline until an incarnation exists", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		let incarnation: number | null = null;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => incarnation,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		store.mint({ spawn: "host" });
		await flush();
		expect(sent).toHaveLength(0);
		incarnation = 4;
		reporter.reconcile();
		await flush();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ action: "session_upsert", params: { sessionId: "host.one", incarnation: 4 } });
	});

	it("re-sends an upsert the Router refused once the window lifts", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const ambient = fakeAmbient({ drive: "manual" });
		const sent: string[] = [];
		let fenced = true;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action) => {
				sent.push(action);
				return fenced ? { result: { outcome: "refused", reason: "migrating" } } : { result: { ok: true } };
			},
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient,
		});
		reporter.attach();
		store.mint({ spawn: "host" });
		await flush();
		fenced = false;
		await ambient.advance(SESSION_REGISTRY_RETRY_MS);
		await ambient.advance(SESSION_REGISTRY_RETRY_MS);

		expect(sent).toEqual(["session_upsert", "session_upsert"]);
	});

	it("re-sends a forget the Router refused, and not the upsert it replaced", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const ambient = fakeAmbient({ drive: "manual" });
		const sent: string[] = [];
		let fenced = true;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action) => {
				sent.push(action);
				return fenced ? { result: { outcome: "refused", reason: "migrating" } } : { result: { ok: true } };
			},
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient,
		});
		reporter.attach();
		const record = store.mint({ spawn: "host" });
		await flush();
		store.forget(store.teamOf(record));
		await flush();
		fenced = false;
		await ambient.advance(SESSION_REGISTRY_RETRY_MS);
		await ambient.advance(SESSION_REGISTRY_RETRY_MS);

		expect(sent).toEqual(["session_upsert", "session_forget", "session_forget"]);
	});
});
