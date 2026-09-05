import crypto from "node:crypto";

declare const timerBrand: unique symbol;
declare const intervalBrand: unique symbol;

export interface TimerHandle {
	readonly [timerBrand]: true;
}

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

export type Clock = Pick<Ambient, "now">;

/** The promise's value, or null once `ms` pass first; the timer never outlives the race. */
export async function withinMs<T>(
	ambient: Pick<Ambient, "setTimer" | "clearTimer">,
	promise: Promise<T>,
	ms: number,
): Promise<T | null> {
	let timer: TimerHandle | undefined;
	const expiry = new Promise<null>((resolve) => {
		timer = ambient.setTimer(() => resolve(null), ms);
	});
	try {
		return await Promise.race([promise, expiry]);
	} finally {
		if (timer) ambient.clearTimer(timer);
	}
}

// Globals enter through this reader. Timer handles are unref'd.
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
