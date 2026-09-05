import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresenceReporter } from "../gateway/router/presenceReporter.js";
import { processAmbient } from "../shared/ambient.js";
import type { PresenceRow } from "../shared/presence-identity.js";
import { PresenceBaselineParamsSchema, PresenceDeltaParamsSchema } from "../shared/schemasRouterPresence.js";

const row = (team: string, status: PresenceRow["status"] = "available"): PresenceRow => ({
	team,
	gatewayId: "gateway",
	status,
	kind: "loose",
	queue_depth: 0,
});

function setup(answers: Array<{ error?: string; result?: unknown }> = []) {
	vi.useFakeTimers();
	let rows = [row("one"), row("two")];
	let incarnation: number | null = 1;
	let spawnPoints = { gatewayId: "gateway", hostSpawns: [] as string[] };
	const frames: Array<{ action: string; params: Record<string, unknown> }> = [];
	const reporter = createPresenceReporter({
		ambient: processAmbient(),
		rows: () => rows,
		spawnPoints: () => spawnPoints,
		incarnation: () => incarnation,
		// The Router client stamps the incarnation on every frame it sends.
		send: async (action, params) => {
			frames.push({ action, params: { ...params, incarnation } });
			return answers.shift() ?? { result: { ok: true } };
		},
		debounceMs: 250,
		retryMs: 30_000,
	});
	return {
		reporter,
		frames,
		setRows: (next: PresenceRow[]) => (rows = next),
		setIncarnation: (next: number | null) => (incarnation = next),
		setSpawnPoints: (hostSpawns: string[]) => (spawnPoints = { gatewayId: "gateway", hostSpawns }),
	};
}

afterEach(() => vi.useRealTimers());

describe("presence reporter", () => {
	it("lands a baseline, then emits a schema-valid delta for net row changes", async () => {
		const { reporter, frames, setRows } = setup();
		await reporter.baseline();
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);

		expect(PresenceBaselineParamsSchema.safeParse(frames[0]?.params).success).toBe(true);
		expect(PresenceDeltaParamsSchema.safeParse(frames[1]?.params).success).toBe(true);
		expect(frames[1]).toEqual({
			action: "presence_delta",
			params: { incarnation: 1, seq: 1, upserts: [row("one", "online")], tombstones: ["two"] },
		});
	});

	it("commits the values captured before an answer arrives", async () => {
		const { reporter, frames, setRows } = setup();
		await reporter.baseline();
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		setRows([row("one", "verifying")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);

		expect(frames.at(-1)?.params).toMatchObject({ upserts: [row("one", "verifying")] });
	});

	it("coalesces mutations within the debounce window", async () => {
		const { reporter, frames, setRows } = setup();
		await reporter.baseline();
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(100);
		setRows([row("one", "verifying")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(150);

		expect(frames.at(-1)).toEqual({
			action: "presence_delta",
			params: { incarnation: 1, seq: 1, upserts: [row("one", "verifying")], tombstones: ["two"] },
		});
	});

	it("parks after a refused baseline and resumes from an explicit resync", async () => {
		const { reporter, frames, setRows } = setup([{ result: { resync: true } }]);
		await reporter.baseline();
		setRows([row("one", "online")]);
		reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		reporter.resync();
		await vi.runAllTimersAsync();

		expect(frames.at(-1)?.action).toBe("presence_baseline");
	});

	it("retries an undelivered frame at the retry floor", async () => {
		const { reporter, frames } = setup([{ error: "offline" }, { result: { ok: true } }]);
		await reporter.baseline();
		await vi.advanceTimersByTimeAsync(29_999);
		expect(frames).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(PresenceBaselineParamsSchema.safeParse(frames.at(-1)?.params).success).toBe(true);
	});

	it("rebaselines when spawn points change and parks while unregistered", async () => {
		const state = setup();
		await state.reporter.baseline();
		state.setSpawnPoints(["linux"]);
		state.reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(state.frames.at(-1)).toMatchObject({
			action: "presence_baseline",
			params: { spawnPoints: { hostSpawns: ["linux"] } },
		});
		state.setIncarnation(null);
		state.reporter.markDirty();
		await vi.advanceTimersByTimeAsync(250);
		expect(state.frames.at(-1)?.params).toMatchObject({ spawnPoints: { hostSpawns: ["linux"] } });
	});
});
