import { describe, expect, it } from "vitest";
import { SessionStore } from "../shared/session-store.js";
import { makeConsoleSeam } from "./helpers/consoleSeam.js";

describe("console session creation through dispatch", () => {
	it("routes a host create through the host daemon with the session name", async () => {
		const h = makeConsoleSeam();
		const result = await h.dispatch({ kind: "create_session", target: "host", sessionName: "scratch" });
		expect(result).toMatchObject({ created: true, id: "scratch" });
		expect(h.hostOps[0]).toMatchObject({
			kind: "createSession",
			target: { kind: "host", name: "host", sessionName: "scratch" },
			workdirHint: "scratch",
		});
	});

	it("routes a devcontainer create through wake without a host create op", async () => {
		const woken: string[] = [];
		const h = makeConsoleSeam({
			tryWakeTeam: async (team) => {
				woken.push(team);
				return { ok: true };
			},
		});
		await h.dispatch({ kind: "create_session", target: "recipe-app", sessionName: "scratch" });
		expect(woken).toEqual(["recipe-app.scratch"]);
		expect(h.hostOps).toHaveLength(0);
	});

	it("mints an id and preserves a valid display label", async () => {
		const store = new SessionStore({ idGen: () => "abc123" });
		const h = makeConsoleSeam({ sessionStore: store });
		const result = await h.dispatch({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" });
		expect(result).toMatchObject({ created: true, id: "abc123", sessionLabel: "My Work", labelSanitized: false });
		expect(store.getByTeam("recipe-app.abc123")?.sessionLabel).toBe("My Work");
	});

	it("reports sanitization when a display label is rejected", async () => {
		const h = makeConsoleSeam({ sessionStore: new SessionStore({ idGen: () => "abc123" }) });
		const result = await h.dispatch({ kind: "create_session", target: "recipe-app", displayLabel: "\u200b" });
		expect(result).toMatchObject({ id: "abc123", sessionLabel: "abc123", labelSanitized: true });
	});

	it("validates workdir before minting or launching", async () => {
		const store = new SessionStore();
		const h = makeConsoleSeam({ sessionStore: store });
		await expect(
			h.dispatch({ kind: "create_session", target: "host", displayLabel: "bad", workdir: "relative" }),
		).rejects.toThrow("workdir");
		expect(store.size).toBe(0);
		expect(h.hostOps).toHaveLength(0);
	});

	it("reattaches a record and passes its resume id to the host", async () => {
		const store = new SessionStore();
		store.adoptById("scratch", {
			spawn: "host",
			sessionLabel: "Saved",
			claudeSessionId: "resume-id",
		});
		const h = makeConsoleSeam({ sessionStore: store });
		await h.dispatch({ kind: "create_session", target: "host", sessionName: "scratch" });
		expect(h.hostOps[0]).toMatchObject({ resumeSessionId: "resume-id" });
	});

	it("keeps an unresolved wake pending and rolls back on definitive failure", async () => {
		let resolveWake: ((result: { ok: false }) => void) | undefined;
		const store = new SessionStore();
		const h = makeConsoleSeam({
			sessionStore: store,
			createSessionBoundMs: 10,
			tryWakeTeam: () => new Promise((resolve) => (resolveWake = resolve)),
		});
		const result = await h.dispatch({ kind: "create_session", target: "recipe-app", sessionName: "scratch" });
		expect(result).toMatchObject({ status: "pending", id: "scratch" });
		resolveWake?.({ ok: false });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(store.getByTeam("recipe-app.scratch")).toBeUndefined();
	});

	it("holds host launch in-flight until registration settles", async () => {
		const releases: string[] = [];
		let resolveRegister: ((result: { ok: true }) => void) | undefined;
		const h = makeConsoleSeam({
			markCreateInFlight: (team) => () => releases.push(team),
			awaitRegister: () => new Promise((resolve) => (resolveRegister = resolve)),
		});
		await h.dispatch({ kind: "create_session", target: "host", sessionName: "scratch" });
		expect(releases).toEqual([]);
		resolveRegister?.({ ok: true });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(releases).toEqual(["host.scratch"]);
	});

	it("does not roll back an ambiguous host launch", async () => {
		const store = new SessionStore({ idGen: () => "abc123" });
		const h = makeConsoleSeam({
			sessionStore: store,
			relayToHost: async () => ({ ok: false, error: "timed out", errorKind: "timeout" }),
		});
		await expect(h.dispatch({ kind: "create_session", target: "host", displayLabel: "Work" })).rejects.toThrow();
		expect(store.getByTeam("host.abc123")).toBeDefined();
	});

	it("rejects foreign and reserved targets before launch", async () => {
		const store = new SessionStore({ clash: (id) => id === "reserved" });
		const h = makeConsoleSeam({ sessionStore: store });
		await expect(
			h.dispatch({ kind: "create_session", target: "other-domain.test-host.host", displayLabel: "x" }),
		).rejects.toThrow("another Gateway");
		await expect(
			h.dispatch({ kind: "create_session", target: "recipe-app", sessionName: "reserved" }),
		).rejects.toThrow("reserved");
		expect(store.size).toBe(0);
	});
});
