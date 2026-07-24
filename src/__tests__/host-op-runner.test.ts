import { describe, expect, it, vi } from "vitest";
import { createHostOpRunner, type TmuxOps } from "../mcp/devcontainer/hostOpRunner.js";
import type { TmuxTarget } from "../shared/host-op.js";

const T: TmuxTarget = { kind: "devcontainer", name: "recipe-app", sessionName: "claude" };

function makeOps(): { ops: TmuxOps } {
	let n = 0;
	const ops: TmuxOps = {
		peekPane: vi.fn(async () => {
			n++;
			return { kind: "tmux" as const, ansi: "SCREEN", hash: `h${n}` };
		}),
		sendText: vi.fn(async () => {}),
		sendKey: vi.fn(async () => {}),
		createSession: vi.fn(async () => {}),
		reloadPlugins: vi.fn(async () => {}),
		killSession: vi.fn(async () => {}),
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
		expect(a).toEqual({ kind: "tmux", ansi: "SCREEN", hash: "h1" });
		expect(b).toEqual({ kind: "tmux", ansi: "SCREEN", hash: "h1" });
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
		expect(h.ops.sendText).toHaveBeenCalledWith(T, "hi", undefined);
		expect(await runner.run({ kind: "sendKey", target: T, key: "C-c" })).toEqual({ sent: true });
		expect(h.ops.sendKey).toHaveBeenCalledWith(T, "C-c");
	});

	it("threads submit:false to sendText so the text is typed without a trailing Enter", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		expect(await runner.run({ kind: "sendText", target: T, text: "/model", submit: false })).toEqual({
			sent: true,
		});
		expect(h.ops.sendText).toHaveBeenCalledWith(T, "/model", false);
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

	it("relays createSession and reloadPlugins and returns their acks", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		expect(await runner.run({ kind: "createSession", target: T })).toEqual({ created: true });
		expect(h.ops.createSession).toHaveBeenCalledWith(T, undefined, undefined, undefined);
		expect(await runner.run({ kind: "reloadPlugins", target: T })).toEqual({ initiated: true });
		expect(h.ops.reloadPlugins).toHaveBeenCalledWith(T);
	});

	it("forwards a createSession workdirHint to the tmux op", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		await runner.run({ kind: "createSession", target: T, workdirHint: "myproject" });
		expect(h.ops.createSession).toHaveBeenCalledWith(T, "myproject", undefined, undefined);
	});

	it("forwards a createSession resumeSessionId to the tmux op, so a reopened session resumes", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		await runner.run({
			kind: "createSession",
			target: T,
			workdirHint: "myproject",
			resumeSessionId: "12345678-1234-1234-1234-123456789abc",
		});
		expect(h.ops.createSession).toHaveBeenCalledWith(
			T,
			"myproject",
			"12345678-1234-1234-1234-123456789abc",
			undefined,
		);
	});

	it("dedups a re-relayed createSession by dedupKey: the session is created once", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		const op = { kind: "createSession", target: T, dedupKey: "conv:new1" } as const;
		expect(await runner.run(op)).toEqual({ created: true });
		expect(await runner.run(op)).toEqual({ created: true }); // a retry replays the ack
		expect(h.ops.createSession).toHaveBeenCalledTimes(1);
	});

	it("dedups a re-relayed reloadPlugins by dedupKey: the reload fires once", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		const op = { kind: "reloadPlugins", target: T, dedupKey: "conv:reload1" } as const;
		await runner.run(op);
		await runner.run(op);
		expect(h.ops.reloadPlugins).toHaveBeenCalledTimes(1);
	});

	// peekPane is a plain async closure here, NOT vi.fn: the spy wrapper's own promise around an
	// async throw transiently trips Node's unhandled-rejection heuristic on a cold run, which would
	// flake these leak/retry assertions.
	it("a failing peek rejects to the caller without leaking an unhandled rejection", async () => {
		const ops: TmuxOps = {
			peekPane: async () => {
				throw new Error("no server running on /tmp/tmux-1000/default");
			},
			sendText: async () => {},
			sendKey: async () => {},
			createSession: async () => {},
			reloadPlugins: async () => {},
			killSession: async () => {},
		};
		const runner = createHostOpRunner(ops, { minPeekIntervalMs: 0 });

		const leaks: unknown[] = [];
		const onLeak = (reason: unknown) => leaks.push(reason);
		process.on("unhandledRejection", onLeak);
		try {
			await expect(runner.run({ kind: "peek", target: T })).rejects.toThrow(/no server running/);
			// one tick lets any leaked rejection surface
			await new Promise((r) => setTimeout(r, 0));
			expect(leaks).toEqual([]);
		} finally {
			process.off("unhandledRejection", onLeak);
		}
	});

	it("does not cache a failed peek: a later peek retries", async () => {
		let calls = 0;
		const ops: TmuxOps = {
			peekPane: async () => {
				calls++;
				if (calls === 1) throw new Error("no server running on /tmp/tmux-1000/default");
				return { kind: "tmux" as const, ansi: "OK", hash: "h" };
			},
			sendText: async () => {},
			sendKey: async () => {},
			createSession: async () => {},
			reloadPlugins: async () => {},
			killSession: async () => {},
		};
		const runner = createHostOpRunner(ops, { minPeekIntervalMs: 0 });
		await expect(runner.run({ kind: "peek", target: T })).rejects.toThrow();
		expect(await runner.run({ kind: "peek", target: T })).toEqual({ kind: "tmux", ansi: "OK", hash: "h" });
		expect(calls).toBe(2);
	});

	it("rejects an unknown op kind", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops);
		await expect(runner.run({ kind: "bogus" } as unknown as Parameters<typeof runner.run>[0])).rejects.toThrow(
			/unknown host op/,
		);
	});
});

describe("createHostOpRunner peek priority lanes", () => {
	/** A controllable peekPane: each call hangs until its own resolver fires, so a test can fill
	 * the concurrency cap deterministically. `admissionOrder` records when a target's peek actually
	 * STARTS (passed the semaphore), independent of when it later resolves - the property this
	 * lane test cares about is admission order, not completion order. */
	function makeControllableOps(): {
		ops: TmuxOps;
		resolveTarget: (name: string) => void;
		admissionOrder: string[];
	} {
		const resolvers = new Map<string, () => void>();
		const admissionOrder: string[] = [];
		const ops: TmuxOps = {
			peekPane: (target) => {
				admissionOrder.push(target.sessionName);
				return new Promise((resolve) => {
					resolvers.set(target.sessionName, () =>
						resolve({ kind: "tmux" as const, ansi: "S", hash: target.sessionName }),
					);
				});
			},
			sendText: async () => {},
			sendKey: async () => {},
			createSession: async () => {},
			reloadPlugins: async () => {},
			killSession: async () => {},
		};
		return { ops, resolveTarget: (name) => resolvers.get(name)?.(), admissionOrder };
	}
	const targetNamed = (n: string): TmuxTarget => ({ kind: "devcontainer", name: n, sessionName: n });
	const tick = () => new Promise((r) => setTimeout(r, 0));

	it("an interactive peek is admitted before an earlier-queued derive peek once a slot frees", async () => {
		const { ops, resolveTarget, admissionOrder } = makeControllableOps();
		const runner = createHostOpRunner(ops, { minPeekIntervalMs: 0 });

		// Fill the concurrency cap (6) with distinct in-flight interactive peeks.
		const capFillers = Array.from({ length: 6 }, (_, i) =>
			runner.peek(targetNamed(`fill-${i}`), { priority: "interactive" }),
		);
		await tick(); // let them all actually start
		expect(admissionOrder).toHaveLength(6);

		// Queue derive-1 first, interactive-1 second - both wait, since every slot is taken.
		const derive = runner.peek(targetNamed("derive-1"), { priority: "derive" });
		await tick();
		const interactive = runner.peek(targetNamed("interactive-1"), { priority: "interactive" });
		await tick();
		expect(admissionOrder).toHaveLength(6); // neither admitted yet

		// Free exactly one slot - the later-queued interactive request must be admitted next, not
		// the earlier-queued derive one.
		resolveTarget("fill-0");
		await tick();
		expect(admissionOrder.at(-1)).toBe("interactive-1");

		// Free a second slot - only derive-1 is left waiting, so it is admitted now.
		resolveTarget("fill-1");
		await tick();
		expect(admissionOrder.at(-1)).toBe("derive-1");

		// Drain everything so the test does not leak pending promises.
		for (let i = 2; i < 6; i++) resolveTarget(`fill-${i}`);
		resolveTarget("interactive-1");
		resolveTarget("derive-1");
		await Promise.all(capFillers);
		await interactive;
		await derive;
	});

	it("forwards resize=false only for a derive-priority peek; a relayed op still resizes (default true)", async () => {
		const h = makeOps();
		const runner = createHostOpRunner(h.ops, { minPeekIntervalMs: 0 });

		await runner.peek(T, { resize: false, priority: "derive" });
		expect(h.ops.peekPane).toHaveBeenLastCalledWith(T, false);

		await runner.run({ kind: "peek", target: { ...T, sessionName: "other" } });
		expect(h.ops.peekPane).toHaveBeenLastCalledWith({ ...T, sessionName: "other" }, true);
	});
});
