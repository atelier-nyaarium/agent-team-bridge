import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createKeyRequester } from "../gateway/router/keyRequester.js";
import { processAmbient, type TimerHandle } from "../shared/ambient.js";
import { generateIdentity } from "../shared/crypto.js";

function clock() {
	let current = 0;
	let nextId = 0;
	const timers = new Map<number, { due: number; run: () => void; handle: TimerHandle }>();
	const setTimer = (run: () => void, delay: number) => {
		const handle = {} as TimerHandle;
		const id = ++nextId;
		timers.set(id, { due: current + delay, run, handle });
		return handle;
	};
	const clearTimer = (handle: TimerHandle) => {
		for (const [id, timer] of timers) if (timer.handle === handle) timers.delete(id);
	};
	const advance = async (milliseconds: number) => {
		current += milliseconds;
		for (;;) {
			const due = [...timers.entries()].find(([, timer]) => timer.due <= current);
			if (!due) break;
			timers.delete(due[0]);
			due[1].run();
			await Promise.resolve();
			await Promise.resolve();
		}
	};
	const ambient = { now: () => current, randomBytes, setTimer, clearTimer };
	return { ambient, now: () => current, advance, timers };
}

function requester(options: { send?: (action: string, params: Record<string, unknown>) => Promise<unknown> } = {}) {
	const identity = generateIdentity();
	const time = clock();
	const sends: Array<{ action: string; params: Record<string, unknown> }> = [];
	const onError = vi.fn();
	const instance = createKeyRequester({
		domainId: "domain",
		gatewayId: "gateway",
		gatewaySignPub: identity.sign.pub,
		gatewaySignPriv: identity.sign.priv,
		send: async (action, params) => {
			sends.push({ action, params });
			return options.send?.(action, params);
		},
		onError,
		ambient: time.ambient,
	});
	return { instance, sends, onError, time };
}

describe("key requester", () => {
	it("coalesces repeated and burst requests", async () => {
		const test = requester();
		test.instance.request(1);
		test.instance.request(1);
		test.instance.request(2);
		await test.time.advance(0);

		expect(test.sends).toHaveLength(1);
		expect(test.sends[0].params).toMatchObject({ request: { epochs: [1, 2] } });
	});

	it("sends the second request ten minutes later", async () => {
		const test = requester();
		test.instance.request(1);
		await test.time.advance(0);
		await test.time.advance(10 * 60 * 1000);

		expect(test.sends).toHaveLength(2);
		expect(test.sends[1].params).toMatchObject({ request: { epochs: [1] } });
	});

	it("stops after 24 hours and reports once per epoch", async () => {
		const test = requester();
		test.instance.request(1);
		test.instance.request(2);
		await test.time.advance(0);
		for (let index = 0; index < 144; index++) await test.time.advance(10 * 60 * 1000);

		expect(test.sends).toHaveLength(144);
		expect(test.onError).toHaveBeenCalledTimes(2);
		expect(test.onError.mock.calls.map(([message]) => message)).toEqual([
			"Gateway gateway could not obtain content key epoch 1",
			"Gateway gateway could not obtain content key epoch 2",
		]);
		await test.time.advance(10 * 60 * 1000);
		expect(test.sends).toHaveLength(144);
		expect(test.onError).toHaveBeenCalledTimes(2);
	});

	it("cancels an installed epoch", async () => {
		const test = requester();
		test.instance.request(1);
		await test.time.advance(0);
		test.instance.installed(1);
		await test.time.advance(24 * 60 * 60 * 1000);

		expect(test.sends).toHaveLength(1);
		expect(test.sends.every(({ params }) => (params.request as { epochs: number[] }).epochs.includes(1))).toBe(
			true,
		);
		expect(test.time.timers.size).toBe(0);
	});

	it("retries after a rejected send", async () => {
		const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
		const test = requester({ send });
		test.instance.request(1);
		await test.time.advance(0);
		await test.time.advance(10 * 60 * 1000);

		expect(send).toHaveBeenCalledTimes(2);
		expect(test.sends).toHaveLength(2);
	});

	it("drops a scheduled timer once its epoch installs", async () => {
		const test = requester();
		test.instance.request(1);
		expect(test.time.timers.size).toBe(1);

		test.instance.installed(1);
		expect(test.time.timers.size).toBe(0);
	});

	// The unref moved to the ambient, which is now the only timer owner.
	it("the process ambient hands back an unref'd timer", () => {
		const handle = processAmbient().setTimer(() => undefined, 60_000) as unknown as {
			hasRef?: () => boolean;
		};
		expect(handle.hasRef?.()).toBe(false);
	});
});
