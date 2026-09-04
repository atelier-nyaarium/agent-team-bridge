import { describe, expect, it } from "vitest";
import { DurableOutbox } from "../shared/durable-outbox.js";

type Item = { key: string; n: number };

function fakeStore(initial: unknown = null) {
	const saved: unknown[] = [];
	const store = {
		failing: false,
		load: () => initial,
		saveChecked(state: unknown) {
			if (store.failing) throw new Error("disk full");
			saved.push(state);
		},
	};
	return { store, saved };
}

function open(store: ReturnType<typeof fakeStore>["store"], maxSize?: number) {
	return new DurableOutbox<Item>({
		durable: store,
		restore: (raw) => (Array.isArray(raw) ? (raw as Item[]) : []),
		keyOf: (item) => item.key,
		maxSize,
	});
}

describe("DurableOutbox", () => {
	it("keeps FIFO order, replaces by key in place, and refuses past its bound", () => {
		const { store, saved } = fakeStore();
		const box = open(store, 2);
		expect(box.enqueue({ key: "a", n: 1 })).toBe("enqueued");
		expect(box.enqueue({ key: "b", n: 1 })).toBe("enqueued");
		expect(box.enqueue({ key: "a", n: 2 })).toBe("replaced");
		expect(box.enqueue({ key: "c", n: 1 })).toBe("refused");
		expect(box.values()).toEqual([
			{ key: "a", n: 2 },
			{ key: "b", n: 1 },
		]);
		expect(saved).toHaveLength(3);
	});

	it("restores what the file held and retires by key or predicate, saving each change", () => {
		const { store, saved } = fakeStore([
			{ key: "a", n: 1 },
			{ key: "b", n: 2 },
			{ key: "c", n: 3 },
		]);
		const box = open(store);
		expect(box.retire("b")).toBe(true);
		expect(box.retire("b")).toBe(false);
		expect(box.retireWhere((item) => item.n > 2)).toEqual([{ key: "c", n: 3 }]);
		expect(box.retireWhere(() => false)).toEqual([]);
		expect(box.values()).toEqual([{ key: "a", n: 1 }]);
		expect(saved).toEqual([
			[
				{ key: "a", n: 1 },
				{ key: "c", n: 3 },
			],
			[{ key: "a", n: 1 }],
		]);
	});

	it("keeps its state when the save of a change fails, and the caller hears the failure", () => {
		const { store } = fakeStore([{ key: "a", n: 1 }]);
		const box = open(store);
		store.failing = true;
		expect(() => box.retire("a")).toThrow("disk full");
		expect(() => box.enqueue({ key: "b", n: 1 })).toThrow("disk full");
		expect(box.values()).toEqual([{ key: "a", n: 1 }]);
	});

	it("drains heads in order and stops at a head the processor leaves in place", async () => {
		const { store } = fakeStore([
			{ key: "a", n: 1 },
			{ key: "b", n: 2 },
			{ key: "c", n: 3 },
		]);
		const box = open(store);
		const seen: string[] = [];
		await box.drain(async (item) => {
			seen.push(item.key);
			if (item.key !== "c") box.retire(item.key);
		});
		expect(seen).toEqual(["a", "b", "c"]);
		expect(box.values()).toEqual([{ key: "c", n: 3 }]);

		// A second drain starts again at the head that was left.
		await box.drain(async (item) => {
			seen.push(item.key);
			box.retire(item.key);
		});
		expect(seen).toEqual(["a", "b", "c", "c"]);
		expect(box.size).toBe(0);
	});

	it("runs one drain at a time", async () => {
		const { store } = fakeStore([{ key: "a", n: 1 }]);
		const box = open(store);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let runs = 0;
		const first = box.drain(async () => {
			runs += 1;
			await gate;
			box.retire("a");
		});
		await box.drain(async () => {
			runs += 1;
		});
		release();
		await first;
		expect(runs).toBe(1);
		expect(box.size).toBe(0);
	});
});
