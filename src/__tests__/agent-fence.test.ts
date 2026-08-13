import { describe, expect, it } from "vitest";
import {
	advancesFence,
	classifyAcceptanceFence,
	classifyEventFence,
	fenceOf,
	sameFence,
} from "../shared/agent-fence.js";

////////////////////////////////
//  Tests
//
//  The two sides deliberately answer the unfenced record differently: an acceptance INSTALLS the
//  first fence, while an event cannot be placed until something does.

const FENCE = { daemonInstanceId: "d1", targetId: "t1", generation: 1, lastEventId: 5 };

describe("agent fence algebra", () => {
	it("an acceptance installs a first fence; an event on an unfenced record is held as foreign", () => {
		expect(classifyAcceptanceFence(undefined, FENCE)).toBe("advances");
		expect(classifyEventFence(undefined, FENCE)).toBe("foreign");
	});

	it("a different supervisor, target, or generation is foreign on both sides", () => {
		for (const next of [
			{ ...FENCE, lastEventId: 9, daemonInstanceId: "d2" },
			{ ...FENCE, lastEventId: 9, targetId: "t2" },
			{ ...FENCE, lastEventId: 9, generation: 2 },
		]) {
			expect(classifyAcceptanceFence(FENCE, next)).toBe("foreign");
			expect(classifyEventFence(FENCE, next)).toBe("foreign");
		}
	});

	it("the same child only advances past its own high-water mark", () => {
		expect(classifyEventFence(FENCE, { ...FENCE, lastEventId: 6 })).toBe("advances");
		expect(classifyEventFence(FENCE, { ...FENCE, lastEventId: 5 })).toBe("duplicate");
		expect(classifyEventFence(FENCE, { ...FENCE, lastEventId: 4 })).toBe("duplicate");
		expect(advancesFence(FENCE, { ...FENCE, lastEventId: 6 })).toBe(true);
		expect(advancesFence(FENCE, { ...FENCE, lastEventId: 5 })).toBe(false);
	});

	it("a message's own event id is the fence it stands at", () => {
		const fence = fenceOf({ daemonInstanceId: "d1", targetId: "t1", generation: 1, eventId: 7 });
		expect(fence).toEqual({ daemonInstanceId: "d1", targetId: "t1", generation: 1, lastEventId: 7 });
		expect(sameFence(fence, { ...fence })).toBe(true);
		expect(sameFence(undefined, fence)).toBe(false);
		expect(sameFence(undefined, undefined)).toBe(true);
	});

	it("sameFence answers false on any single differing coordinate", () => {
		for (const other of [
			{ ...FENCE, daemonInstanceId: "d2" },
			{ ...FENCE, targetId: "t2" },
			{ ...FENCE, generation: 2 },
			{ ...FENCE, lastEventId: 6 },
		]) {
			expect(sameFence(FENCE, other)).toBe(false);
		}
	});
});
