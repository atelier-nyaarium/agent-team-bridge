// The clock, the entropy, the ids, and the timers, as one injected record.

import crypto from "node:crypto";

////////////////////////////////
//  Interfaces & Types

declare const timerBrand: unique symbol;
declare const intervalBrand: unique symbol;

/** Opaque one-shot timer handle. */
export interface TimerHandle {
	readonly [timerBrand]: true;
}

/** Opaque repeating timer handle. */
export interface IntervalHandle {
	readonly [intervalBrand]: true;
}

export interface Ambient {
	now(): number;
	randomBytes(size: number): Buffer;
	newId(): string;
	setTimer(run: () => void, ms: number): TimerHandle;
	clearTimer(handle: TimerHandle): void;
	setInterval(run: () => void, ms: number): IntervalHandle;
	clearInterval(handle: IntervalHandle): void;
}

/** The clock alone, for a module that reads nothing else. */
export type Clock = Pick<Ambient, "now">;

////////////////////////////////
//  Functions & Helpers

/** The one reader of the globals, unref'd so no timer holds the runtime open. */
export function processAmbient(): Ambient {
	return {
		now: () => Date.now(),
		randomBytes: (size) => crypto.randomBytes(size),
		newId: () => crypto.randomUUID(),
		setTimer: (run, ms) => {
			const handle = setTimeout(run, ms);
			handle.unref?.();
			return handle as unknown as TimerHandle;
		},
		clearTimer: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
		setInterval: (run, ms) => {
			const handle = setInterval(run, ms);
			handle.unref?.();
			return handle as unknown as IntervalHandle;
		},
		clearInterval: (handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>),
	};
}
