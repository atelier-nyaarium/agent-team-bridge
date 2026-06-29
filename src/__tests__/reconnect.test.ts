import { describe, expect, it } from "vitest";
import { createReconnector } from "../shared/reconnect.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createReconnector", () => {
	it("fires connect after the scheduled delay", async () => {
		let calls = 0;
		const r = createReconnector(() => calls++, { initialDelayMs: 20, maxDelayMs: 200 });
		r.schedule();
		expect(calls).toBe(0);
		await tick(60);
		expect(calls).toBe(1);
	});

	it("does not stack a second timer while a reconnect is already pending", async () => {
		let calls = 0;
		const r = createReconnector(() => calls++, { initialDelayMs: 20, maxDelayMs: 200 });
		r.schedule();
		r.schedule();
		await tick(60);
		expect(calls).toBe(1);
	});

	it("cancel stops a pending reconnect from firing", async () => {
		let calls = 0;
		const r = createReconnector(() => calls++, { initialDelayMs: 20, maxDelayMs: 200 });
		r.schedule();
		r.cancel();
		await tick(60);
		expect(calls).toBe(0);
	});

	it("schedule works again after a cancel", async () => {
		let calls = 0;
		const r = createReconnector(() => calls++, { initialDelayMs: 20, maxDelayMs: 200 });
		r.schedule();
		r.cancel();
		r.schedule();
		await tick(60);
		expect(calls).toBe(1);
	});
});
