import { describe, expect, it } from "vitest";
import { createSessionRegistryReporter } from "../gateway/router/sessionRegistryReporter.js";
import { SessionStore } from "../shared/session-store.js";

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

describe("session registry reporter", () => {
	it("reports a minted session once", async () => {
		const store = new SessionStore({ idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => 3,
			localGatewayId: "gateway",
		});
		reporter.attach();
		store.mint({ spawn: "host", sessionLabel: "Work" });
		await flush();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ action: "session_upsert", params: { sessionId: "host.one", label: "Work" } });
	});

	it("reports a swept session by its spawn id", async () => {
		let now = 100;
		const store = new SessionStore({ now: () => now, idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => 3,
			localGatewayId: "gateway",
		});
		reporter.attach();
		store.mint({ spawn: "host" });
		now = 200;
		store.sweep(50);
		await flush();

		expect(sent.at(-1)).toMatchObject({ action: "session_forget", params: { sessionId: "host.one" } });
	});

	it("reconcile reports records that vanished", async () => {
		const store = new SessionStore({ idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => 3,
			localGatewayId: "gateway",
		});
		const record = store.mint({ spawn: "host" });
		reporter.reconcile();
		store.forget(store.teamOf(record));
		reporter.reconcile();
		await flush();

		expect(sent.at(-1)).toMatchObject({ action: "session_forget", params: { sessionId: "host.one" } });
	});

	it("defers the baseline until an incarnation exists", async () => {
		const store = new SessionStore({ idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		let incarnation: number | null = null;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => incarnation,
			localGatewayId: "gateway",
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
});
