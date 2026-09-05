// The harness's ambient: a clock the scenario moves, entropy seeded per instance, and timers that
// either ride real time (so every scenario makes progress unchanged) or wait for `advance`.

import crypto from "node:crypto";
import type { Ambient, IntervalHandle, TimerHandle } from "../shared/ambient.js";

////////////////////////////////
//  Interfaces & Types

export interface FakeAmbientOptions {
	/** The clock this one is offset from. Defaults to the process clock. */
	now?: () => number;
	/**
	 * "real" rides the process timers, which is what keeps the persist tick, the presence watch, the
	 * awareness tick, the inbox pump, and the reconciler firing. "manual" holds every timer until
	 * `advance` reaches its deadline.
	 */
	drive?: "real" | "manual";
	/** Fixes the entropy stream. Defaults to a fresh draw, so two instances never collide. */
	seed?: Buffer;
}

export interface FakeAmbient extends Ambient {
	/**
	 * Moves the clock. Under manual drive every timer whose deadline the move passes runs at its own
	 * deadline, intervals repeating, with the event loop given a turn between firings so the I/O and
	 * promises a real elapsed second would have settled do settle.
	 */
	advance(ms: number): Promise<void>;
	/** Timers still scheduled under manual drive. */
	scheduled(): number;
}

interface Scheduled {
	id: number;
	at: number;
	everyMs: number | null;
	run: () => void;
}

////////////////////////////////
//  Functions & Helpers

const ADVANCE_STEP_LIMIT = 20_000;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function fakeAmbient(options: FakeAmbientOptions = {}): FakeAmbient {
	const base = options.now ?? Date.now;
	const manual = options.drive === "manual";
	const seed = options.seed ?? crypto.randomBytes(32);
	let offset = 0;
	let draws = 0;
	let nextId = 1;
	const held = new Map<number, Scheduled>();
	const running = new Map<number, () => void>();

	const now = (): number => base() + offset;

	const drawBytes = (size: number): Buffer => {
		const chunks: Buffer[] = [];
		let filled = 0;
		while (filled < size) {
			const block = crypto.createHash("sha256").update(seed).update(String(draws)).digest();
			draws += 1;
			chunks.push(block);
			filled += block.length;
		}
		return Buffer.concat(chunks).subarray(0, size);
	};

	const start = (run: () => void, ms: number, everyMs: number | null): number => {
		const id = nextId;
		nextId += 1;
		if (manual) {
			held.set(id, { id, at: now() + Math.max(0, ms), everyMs, run });
			return id;
		}
		if (everyMs === null) {
			const handle = setTimeout(run, ms);
			handle.unref?.();
			running.set(id, () => clearTimeout(handle));
		} else {
			const handle = setInterval(run, ms);
			handle.unref?.();
			running.set(id, () => clearInterval(handle));
		}
		return id;
	};

	const stop = (id: number): void => {
		held.delete(id);
		running.get(id)?.();
		running.delete(id);
	};

	// Never runs backwards, so a real base drifting under a manual scenario cannot rewind it.
	const setClock = (to: number): void => {
		offset = Math.max(offset, to - base());
	};

	const dueBefore = (target: number): Scheduled | undefined => {
		let soonest: Scheduled | undefined;
		for (const entry of held.values()) {
			if (entry.at > target) continue;
			if (!soonest || entry.at < soonest.at || (entry.at === soonest.at && entry.id < soonest.id)) {
				soonest = entry;
			}
		}
		return soonest;
	};

	return {
		now,
		randomBytes: drawBytes,
		newId: () => {
			const bytes = drawBytes(16);
			bytes[6] = (bytes[6]! & 0x0f) | 0x40;
			bytes[8] = (bytes[8]! & 0x3f) | 0x80;
			const hex = bytes.toString("hex");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		},
		setTimer: (run, ms) => start(run, ms, null) as unknown as TimerHandle,
		clearTimer: (handle) => stop(handle as unknown as number),
		setInterval: (run, ms) => start(run, ms, Math.max(1, ms)) as unknown as IntervalHandle,
		clearInterval: (handle) => stop(handle as unknown as number),
		advance: async (ms) => {
			const target = now() + Math.max(0, ms);
			for (let step = 0; step < ADVANCE_STEP_LIMIT; step += 1) {
				const entry = dueBefore(target);
				if (!entry) break;
				setClock(entry.at);
				if (entry.everyMs === null) held.delete(entry.id);
				else entry.at += entry.everyMs;
				try {
					entry.run();
				} catch (error) {
					console.error(`[fake-ambient] timer threw: ${(error as Error).message}`);
				}
				await yieldToLoop();
			}
			setClock(target);
			await yieldToLoop();
		},
		scheduled: () => held.size,
	};
}
