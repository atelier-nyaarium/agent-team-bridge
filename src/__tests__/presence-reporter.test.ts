import { describe, expect, it, vi } from "vitest";
import { createPresenceReporter } from "../gateway/router/presenceReporter.js";
import type { PresenceRow } from "../shared/presence-identity.js";

const row = (team: string, status: PresenceRow["status"] = "available"): PresenceRow => ({
	team,
	gatewayId: "gateway",
	status,
	kind: "loose",
	queue_depth: 0,
});

function setup(initial: PresenceRow[] = [row("one"), row("two")]) {
	vi.useFakeTimers();
	let rows = initial;
	let incarnation: number | null = 1;
	let spawnPoints = { gatewayId: "gateway", hostSpawns: [] as string[] };
	// The Router acknowledges a landed frame; anything else is not a delivery.
	type Answer = { error?: string; result?: { ok?: boolean; resync?: boolean; error?: string } };
	const send = vi.fn(
		async (_action: string, _params: Record<string, unknown>): Promise<Answer> => ({ result: { ok: true } }),
	);
	const reporter = createPresenceReporter({
		rows: () => rows,
		spawnPoints: () => spawnPoints,
		send,
		incarnation: () => incarnation,
		debounceMs: 250,
	});
	return {
		reporter,
		send,
		setRows: (next: PresenceRow[]) => (rows = next),
		setIncarnation: (next: number | null) => (incarnation = next),
		setSpawnPoints: (hostSpawns: string[]) => (spawnPoints = { gatewayId: "gateway", hostSpawns }),
	};
}

describe("presence reporter", () => {
	it("sends only changed rows and tombstones", async () => {
		const { reporter, send, setRows } = setup();
		await reporter.baseline();
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send.mock.calls[1]?.[0]).toBe("presence_delta");
		expect(send.mock.calls[1]?.[1]).toMatchObject({ seq: 1, upserts: [row("one", "online")], tombstones: ["two"] });
	});

	it("commits the snapshot sent on the wire", async () => {
		const { reporter, send, setRows } = setup([row("one")]);
		let release: (() => void) | undefined;
		let startedResolve: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		send.mockImplementationOnce(
			async (_action, params) =>
				new Promise((resolve) => {
					startedResolve?.();
					release = () => resolve({ result: { ok: true } });
				}),
		);

		const baselinePromise = reporter.baseline();
		await started;
		setRows([row("one", "online")]);
		release?.();
		await baselinePromise;
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);

		expect(send.mock.calls[0]?.[1]).toMatchObject({ rows: [row("one")] });
		expect(send.mock.calls[1]?.[1]).toMatchObject({ upserts: [row("one", "online")] });
	});

	it("never sends two deltas concurrently", async () => {
		const { reporter, send, setRows } = setup([row("one")]);
		await reporter.baseline();
		let release: (() => void) | undefined;
		let inFlight = 0;
		let maxInFlight = 0;
		send.mockImplementation(async (_action, params) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (send.mock.calls.length === 2) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			inFlight--;
			return { result: { ok: true }, params };
		});

		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		setRows([row("one", "verifying")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(maxInFlight).toBe(1);
		expect(send.mock.calls.slice(1).map((call) => (call[1] as { seq: number }).seq)).toEqual([1]);

		release?.();
		await vi.advanceTimersByTimeAsync(250);
		expect(maxInFlight).toBe(1);
		expect(send.mock.calls.slice(1).map((call) => (call[1] as { seq: number }).seq)).toEqual([1, 2]);
	});

	it("coalesces changes during the debounce window", async () => {
		const { reporter, send, setRows } = setup([row("one")]);
		await reporter.baseline();
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(100);
		setRows([row("one", "verifying")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1]?.[1]).toMatchObject({ upserts: [row("one", "verifying")] });
	});

	it("holds deltas until a refused baseline is asked for again", async () => {
		const { reporter, send, setRows } = setup([row("one")]);
		send.mockResolvedValueOnce({ result: { resync: true } });
		await reporter.baseline();
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.runAllTimersAsync();
		expect(send).toHaveBeenCalledTimes(1);

		reporter.resync();
		await vi.runAllTimersAsync();
		expect(send.mock.calls[1]?.[0]).toBe("presence_baseline");
		setRows([row("one", "verifying")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send.mock.calls[2]?.[1]).toMatchObject({ seq: 1 });
	});

	it("retries a baseline that never landed, since an idle gateway sends nothing else", async () => {
		const { reporter, send } = setup([row("one")]);
		send.mockResolvedValueOnce({ error: "offline" } as never);
		await reporter.baseline();
		expect(send).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1]?.[0]).toBe("presence_baseline");
	});

	it("treats a frame the Router refused without a resync as undelivered", async () => {
		const { reporter, send, setRows } = setup([row("one")]);
		send.mockResolvedValueOnce({ result: { ok: false, error: "stale_incarnation" } } as never);
		await reporter.baseline();
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("suppresses deltas after a baseline error until a later baseline succeeds", async () => {
		const { reporter, send, setRows } = setup([row("one")]);
		send.mockResolvedValueOnce({ error: "offline" });
		await reporter.baseline();
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send).toHaveBeenCalledTimes(1);

		setRows([row("one")]);
		await reporter.baseline();
		setRows([row("one", "verifying")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send.mock.calls[2]?.[1]).toMatchObject({ seq: 1 });
	});

	it("reuses a delta sequence after a send error, on the retry delay not the debounce", async () => {
		const { reporter, send, setRows } = setup([row("one")]);
		await reporter.baseline();
		send.mockResolvedValueOnce({ error: "offline" } as never);
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send.mock.calls[1]?.[1]).toMatchObject({ seq: 1 });

		// The debounce would spin at four attempts a second while the Router keeps failing.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(send).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(send.mock.calls[2]?.[1]).toMatchObject({ seq: 1 });
	});

	it("keeps flushing while a healthy Router faces churn faster than the window", async () => {
		// An extendable window would be pushed past every fire and nothing would ever go out.
		const { reporter, send, setRows } = setup([row("one")]);
		await reporter.baseline();
		for (let i = 0; i < 30; i++) {
			setRows([{ ...row("one"), queue_depth: i + 1 }]);
			reporter.markDirty();
			await vi.advanceTimersByTimeAsync(100);
		}

		expect(send.mock.calls.filter((call) => call[0] === "presence_delta").length).toBeGreaterThan(5);
	});

	it("rebaselines when the spawn points change, since only a baseline carries them", async () => {
		const { reporter, send, setSpawnPoints } = setup([row("one")]);
		await reporter.baseline();
		setSpawnPoints(["linux"]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);

		expect(send.mock.calls[1]?.[0]).toBe("presence_baseline");
		expect(send.mock.calls[1]?.[1]).toMatchObject({ spawnPoints: { hostSpawns: ["linux"] } });
	});

	it("does not let a busy gateway outvote the retry floor", async () => {
		// Without the floor, rows that keep changing re-arm the debounce and hammer a failing Router.
		const { reporter, send, setRows } = setup([row("one")]);
		await reporter.baseline();
		send.mockResolvedValue({ error: "offline" } as never);
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send).toHaveBeenCalledTimes(2);

		for (let i = 0; i < 50; i++) {
			reporter.markDirty();
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(send).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("rebaselines when a delta is refused", async () => {
		const { reporter, send, setRows } = setup([row("one")]);
		await reporter.baseline();
		send.mockResolvedValueOnce({ result: { resync: true } });
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.runAllTimersAsync();
		expect(send.mock.calls[2]?.[0]).toBe("presence_baseline");

		setRows([row("one", "verifying")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send.mock.calls[3]?.[1]).toMatchObject({ seq: 1 });
	});

	it("sends nothing while unregistered", async () => {
		const { reporter, send, setIncarnation } = setup();
		setIncarnation(null);
		await reporter.baseline();
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(send).not.toHaveBeenCalled();
		vi.useRealTimers();
	});
});
