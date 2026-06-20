import { describe, expect, it, vi } from "vitest";
import { createHostOpRunner, type TmuxOps } from "../mcp/devcontainer/hostOpRunner.js";
import type { TmuxTarget } from "../shared/host-op.js";

const T: TmuxTarget = { kind: "devcontainer", name: "recipe-app" };

function makeOps(): { ops: TmuxOps } {
	let n = 0;
	const ops: TmuxOps = {
		peekPane: vi.fn(async () => {
			n++;
			return { ansi: "SCREEN", hash: `h${n}` };
		}),
		sendText: vi.fn(async () => {}),
		sendKey: vi.fn(async () => {}),
	};
	return { ops };
}

describe("createHostOpRunner", () => {
	it("single-flights concurrent peeks of the same pane into one capture", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops, { minPeekIntervalMs: 0 });
		const [a, b] = await Promise.all([
			runner.run({ kind: "peek", target: T }),
			runner.run({ kind: "peek", target: T }),
		]);
		expect(a).toEqual({ ansi: "SCREEN", hash: "h1" });
		expect(b).toEqual({ ansi: "SCREEN", hash: "h1" });
		expect(h.ops.peekPane).toHaveBeenCalledTimes(1);
	});

	it("reuses the last capture within the cadence floor (no extra docker exec)", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops, { minPeekIntervalMs: 10_000, now: () => 1000 });
		await runner.run({ kind: "peek", target: T });
		await runner.run({ kind: "peek", target: T });
		expect(h.ops.peekPane).toHaveBeenCalledTimes(1);
	});

	it("captures fresh once the floor has elapsed", async () => {
		const h = makeOps();
		let t = 1000;
		const runner = createHostOpRunner(h.ops, { minPeekIntervalMs: 300, now: () => t });
		await runner.run({ kind: "peek", target: T });
		t = 2000; // past the floor
		await runner.run({ kind: "peek", target: T });
		expect(h.ops.peekPane).toHaveBeenCalledTimes(2);
	});

	it("relays sendText and sendKey to the tmux ops and returns sent", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		expect(await runner.run({ kind: "sendText", target: T, text: "hi" })).toEqual({ sent: true });
		expect(h.ops.sendText).toHaveBeenCalledWith(T, "hi");
		expect(await runner.run({ kind: "sendKey", target: T, key: "C-c" })).toEqual({ sent: true });
		expect(h.ops.sendKey).toHaveBeenCalledWith(T, "C-c");
	});

	it("dedups a re-relayed send by dedupKey: the keystrokes are injected once", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		const op = { kind: "sendText", target: T, text: "ls", dedupKey: "conv:op1" } as const;
		expect(await runner.run(op)).toEqual({ sent: true });
		expect(await runner.run(op)).toEqual({ sent: true }); // a retry replays the ack
		expect(h.ops.sendText).toHaveBeenCalledTimes(1);
	});

	it("single-flights concurrent sends with the same dedupKey into one injection", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		const op = { kind: "sendKey", target: T, key: "Enter", dedupKey: "conv:op2" } as const;
		await Promise.all([runner.run(op), runner.run(op)]);
		expect(h.ops.sendKey).toHaveBeenCalledTimes(1);
	});

	it("does not dedup sends with different dedupKeys", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		await runner.run({ kind: "sendText", target: T, text: "a", dedupKey: "conv:op1" });
		await runner.run({ kind: "sendText", target: T, text: "b", dedupKey: "conv:op2" });
		expect(h.ops.sendText).toHaveBeenCalledTimes(2);
	});

	it("rejects an unknown op kind", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		await expect(runner.run({ kind: "bogus" } as unknown as Parameters<typeof runner.run>[0])).rejects.toThrow(
			/unknown host op/,
		);
	});
});
