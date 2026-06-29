////////////////////////////////
//  Interfaces & Types

export interface ReconnectorOptions {
	maxDelayMs?: number;
	initialDelayMs?: number;
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

	let timer: ReturnType<typeof setTimeout> | null = null;
	let delay = initialDelayMs;

	function schedule(): void {
		if (timer) return;
		timer = setTimeout(() => {
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
			clearTimeout(timer);
			timer = null;
		}
	}

	return { schedule, reset, cancel };
}
