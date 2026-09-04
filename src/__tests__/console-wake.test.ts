import { describe, expect, it } from "vitest";
import type { WakeResult } from "../gateway/wake.js";
import { SessionStore } from "../shared/session-store.js";
import { makeConsoleSeam } from "./helpers/consoleSeam.js";

describe("console wake through dispatch", () => {
	it("wakes the local composite behind a qualified target", async () => {
		const woken: string[] = [];
		const h = makeConsoleSeam({
			tryWakeTeam: async (team) => {
				woken.push(team);
				return { ok: true };
			},
		});
		expect(await h.dispatch({ kind: "wake", target: "test-domain.test-host.recipe-app.scratch" })).toEqual({
			ok: true,
		});
		expect(woken).toEqual(["recipe-app.scratch"]);
	});

	it("refuses a spawn-point or foreign target before waking anything", async () => {
		const woken: string[] = [];
		const h = makeConsoleSeam({
			tryWakeTeam: async (team) => {
				woken.push(team);
				return { ok: true };
			},
		});
		await expect(h.dispatch({ kind: "wake", target: "test-domain.test-host.recipe-app" })).rejects.toThrow(
			"spawn-point",
		);
		await expect(h.dispatch({ kind: "wake", target: "other-domain.other-gw.recipe-app.scratch" })).rejects.toThrow(
			"another Gateway",
		);
		expect(woken).toEqual([]);
	});

	it("reports a failed wake as an op failure with its reason", async () => {
		const h = makeConsoleSeam({ tryWakeTeam: async () => ({ ok: false, errorKind: "disconnected" }) });
		await expect(h.dispatch({ kind: "wake", target: "recipe-app.scratch" })).rejects.toThrow("not connected");

		const refused = makeConsoleSeam({ tryWakeTeam: async () => ({ ok: false, error: "no such record" }) });
		await expect(refused.dispatch({ kind: "wake", target: "recipe-app.scratch" })).rejects.toThrow(
			"no such record",
		);
	});

	it("adopts a recordless session under its own id before waking, and forgets it when the launch fails", async () => {
		const store = new SessionStore();
		const woken: string[] = [];
		const failing = makeConsoleSeam({
			sessionStore: store,
			tryWakeTeam: async (team) => {
				woken.push(team);
				return { ok: false, errorKind: "timeout" };
			},
		});
		await expect(failing.dispatch({ kind: "wake", target: "recipe-app.scratch" })).rejects.toThrow("come online");
		expect(woken).toEqual(["recipe-app.scratch"]);
		expect(store.getByTeam("recipe-app.scratch")).toBeUndefined();

		const landing = makeConsoleSeam({ sessionStore: store, tryWakeTeam: async () => ({ ok: true }) });
		expect(await landing.dispatch({ kind: "wake", target: "recipe-app.scratch" })).toEqual({ ok: true });
		expect(store.getByTeam("recipe-app.scratch")?.id).toBe("scratch");
	});

	it("wakes an existing record as it is, label and all", async () => {
		const store = new SessionStore();
		store.adoptById("scratch", { spawn: "recipe-app", sessionLabel: "Keep Me" });
		const h = makeConsoleSeam({ sessionStore: store, tryWakeTeam: async () => ({ ok: false, error: "nope" }) });
		await expect(h.dispatch({ kind: "wake", target: "recipe-app.scratch" })).rejects.toThrow("nope");
		expect(store.getByTeam("recipe-app.scratch")?.sessionLabel).toBe("Keep Me");
	});

	it("answers pending when the launch outlasts the bound, and lets it finish", async () => {
		let settle: ((r: WakeResult) => void) | undefined;
		const h = makeConsoleSeam({
			createSessionBoundMs: 5,
			tryWakeTeam: () =>
				new Promise<WakeResult>((resolve) => {
					settle = resolve;
				}),
		});
		expect(await h.dispatch({ kind: "wake", target: "recipe-app.scratch" })).toEqual({
			ok: true,
			status: "pending",
		});
		settle?.({ ok: true });
	});
});
