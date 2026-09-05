////////////////////////////////
//  Interfaces & Types

import type { Ambient, TimerHandle } from "./ambient.js";

export interface ReconnectorOptions {
	maxDelayMs?: number;
	initialDelayMs?: number;
	/**
	 * Absent for the MCP host daemon, whose only live handle between connections is this timer, so
	 * its fallback must hold the loop open rather than unref like a graph's ambient.
	 */
	ambient?: Pick<Ambient, "setTimer" | "clearTimer">;
}

export interface Reconnector {
	schedule(): void;
	reset(): void;
	cancel(): void;
}

////////////////////////////////
//  Functions & Helpers

export function createReconnector(connectFn: () => void, options: ReconnectorOptions = {}): Reconnector {
	const maxDelayMs = options.maxDelayMs ?? 30000;
	const initialDelayMs = options.initialDelayMs ?? 2000;
	const ambient: Pick<Ambient, "setTimer" | "clearTimer"> = options.ambient ?? {
		setTimer: (run, ms) => setTimeout(run, ms) as unknown as TimerHandle,
		clearTimer: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
	};

	let timer: TimerHandle | null = null;
	let delay = initialDelayMs;

	function schedule(): void {
		if (timer) return;
		timer = ambient.setTimer(() => {
			timer = null;
			connectFn();
		}, delay);
		delay = Math.min(delay * 2, maxDelayMs);
	}

	function reset(): void {
		delay = initialDelayMs;
	}

	function cancel(): void {
		if (timer) {
			ambient.clearTimer(timer);
			timer = null;
		}
	}

	return { schedule, reset, cancel };
}
