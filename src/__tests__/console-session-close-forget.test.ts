import { describe, expect, it } from "vitest";
import { SessionStore } from "../shared/session-store.js";
import { makeConsoleSeam } from "./helpers/consoleSeam.js";

describe("console session close, forget, and rename through dispatch", () => {
	it("renames a local composite session and returns the applied label", async () => {
		const store = new SessionStore();
		store.adoptById("scratch", { spawn: "recipe-app", sessionLabel: "old" });
		const h = makeConsoleSeam({ sessionStore: store });
		expect(
			await h.dispatch({ kind: "rename_session", target: "recipe-app.scratch", sessionLabel: "New Name" }),
		).toEqual({
			renamed: true,
			sessionLabel: "New Name",
		});
	});

	it("rejects bare and foreign rename targets", async () => {
		const h = makeConsoleSeam({ sessionStore: new SessionStore() });
		await expect(h.dispatch({ kind: "rename_session", target: "recipe-app", sessionLabel: "x" })).rejects.toThrow(
			"spawn-point",
		);
		await expect(
			h.dispatch({
				kind: "rename_session",
				target: "other-domain.other-gw.recipe-app.scratch",
				sessionLabel: "x",
			}),
		).rejects.toThrow("another Gateway");
	});

	it("closes a session while keeping its resume record", async () => {
		const store = new SessionStore();
		store.adoptById("scratch", { spawn: "recipe-app", sessionLabel: "keep" });
		const h = makeConsoleSeam({ sessionStore: store });
		expect(await h.dispatch({ kind: "close_session", target: "recipe-app.scratch" })).toEqual({ closed: true });
		expect(store.getByTeam("recipe-app.scratch")).toBeDefined();
		expect(h.hostOps[0]).toMatchObject({ kind: "killSession" });
	});

	it("refuses close during wake or for an alias-served record", async () => {
		const h = makeConsoleSeam({ isWakeInFlight: () => true });
		await expect(h.dispatch({ kind: "close_session", target: "recipe-app.scratch" })).rejects.toThrow("waking");

		const store = new SessionStore();
		store.adoptById("main", { spawn: "recipe-app", sessionLabel: "keep" });
		store.confirm("recipe-app.main", { team: "recipe-app.other", subId: "s" });
		const alias = makeConsoleSeam({ sessionStore: store });
		await expect(alias.dispatch({ kind: "close_session", target: "recipe-app.main" })).rejects.toThrow(
			"user-launched",
		);
	});

	it("forgets the resume record even when killing fails", async () => {
		const dropped: string[] = [];
		const h = makeConsoleSeam({
			relayToHost: async () => ({ ok: false, error: "gone" }),
			dropSessionResume: (team) => dropped.push(team),
		});
		expect(await h.dispatch({ kind: "forget", target: "recipe-app.scratch" })).toEqual({
			killed: true,
			boardDisposition: "release",
		});
		expect(dropped).toEqual(["recipe-app.scratch"]);
	});

	it("forgets an unknown project without attempting a host operation", async () => {
		const dropped: string[] = [];
		const h = makeConsoleSeam({
			isTrustedCatalogProject: () => false,
			dropSessionResume: (team) => dropped.push(team),
		});
		expect(await h.dispatch({ kind: "forget", target: "recipe-app.scratch" })).toMatchObject({ killed: true });
		expect(dropped).toEqual(["recipe-app.scratch"]);
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects forgetting a bare spawn point before dropping a record", async () => {
		const dropped: string[] = [];
		const h = makeConsoleSeam({ dropSessionResume: (team) => dropped.push(team) });
		await expect(h.dispatch({ kind: "forget", target: "recipe-app" })).rejects.toThrow("spawn-point");
		expect(dropped).toEqual([]);
	});
});
