import { describe, expect, it } from "vitest";
import type { WakeResult } from "../gateway/wake.js";
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
