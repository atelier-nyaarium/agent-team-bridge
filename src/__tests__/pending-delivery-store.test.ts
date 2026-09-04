import { describe, expect, it } from "vitest";
import {
	type DeliverySnapshotSink,
	MAX_PENDING_DELIVERIES_PER_TEAM,
	type PendingDelivery,
	PendingDeliveryStore,
} from "../shared/pending-delivery-store.js";

/** A snapshot sink that keeps what it was handed, so persistence is observable without disk. */
function fakeDurable(seed?: unknown): { store: DeliverySnapshotSink; read: () => unknown } {
	let saved: unknown = seed;
	return {
		store: {
			load: () => saved ?? null,
			saveChecked: (state: unknown) => {
				saved = state;
			},
		},
		read: () => saved,
	};
}

function delivery(id: string, team = "proj.alpha", at = 1_000): PendingDelivery {
	return { deliveryId: id, team, channelJobId: `job-${team}`, from: "pixel", body: "hi", enqueuedAt: at };
}

describe("PendingDeliveryStore", () => {
	it("holds a message for a team and hands it back in acceptance order", () => {
		const s = new PendingDeliveryStore();
		expect(s.enqueue(delivery("d1"))).toBe("enqueued");
		expect(s.enqueue(delivery("d2"))).toBe("enqueued");
		expect(s.listForTeam("proj.alpha").map((d) => d.deliveryId)).toEqual(["d1", "d2"]);
	});

	it("takes a repeat of the same message as already held, so a retry cannot double-deliver", () => {
		const s = new PendingDeliveryStore();
		expect(s.enqueue(delivery("d1"))).toBe("enqueued");
		expect(s.enqueue(delivery("d1"))).toBe("duplicate");
		expect(s.listForTeam("proj.alpha")).toHaveLength(1);
	});

	it("retires a row only on acknowledgement, and tolerates a second one", () => {
		const s = new PendingDeliveryStore();
		s.enqueue(delivery("d1"));
		expect(s.acknowledge("d1")).toBe(true);
		expect(s.listForTeam("proj.alpha")).toHaveLength(0);
		// A receiver that acknowledges twice is not an error; the row is simply already gone.
		expect(s.acknowledge("d1")).toBe(false);
	});

	it("refuses when a team is full rather than evicting somebody's older message", () => {
		// Silently dropping the oldest would break the same promise the store exists to keep.
		const s = new PendingDeliveryStore(undefined, undefined, 2);
		expect(s.enqueue(delivery("d1"))).toBe("enqueued");
		expect(s.enqueue(delivery("d2"))).toBe("enqueued");
		expect(s.enqueue(delivery("d3"))).toBe("refused");
		expect(s.listForTeam("proj.alpha").map((d) => d.deliveryId)).toEqual(["d1", "d2"]);
	});

	it("caps the shared total, so one unreachable session cannot consume every other's room", () => {
		const s = new PendingDeliveryStore(undefined, undefined, MAX_PENDING_DELIVERIES_PER_TEAM, 2);
		expect(s.enqueue(delivery("d1", "a"))).toBe("enqueued");
		expect(s.enqueue(delivery("d2", "b"))).toBe("enqueued");
		expect(s.enqueue(delivery("d3", "c"))).toBe("refused");
	});

	it("hands back everything it drops for a team, so each can be reported", () => {
		const s = new PendingDeliveryStore();
		s.enqueue(delivery("d1"));
		s.enqueue(delivery("d2"));
		expect((s.failTeam("proj.alpha") as PendingDelivery[]).map((d) => d.deliveryId)).toEqual(["d1", "d2"]);
		expect(s.size).toBe(0);
		// And the ids are free again, so the same message could legitimately be re-accepted later.
		expect(s.enqueue(delivery("d1"))).toBe("enqueued");
	});

	it("expires on age and returns what it dropped, rather than deleting quietly", () => {
		let now = 1_000;
		const s = new PendingDeliveryStore(undefined, 100, undefined, undefined, () => now);
		s.enqueue(delivery("old", "proj.alpha", 1_000));
		now = 2_000;
		s.enqueue(delivery("fresh", "proj.alpha", 2_000));
		expect((s.sweep() as PendingDelivery[]).map((d) => d.deliveryId)).toEqual(["old"]);
		expect(s.listForTeam("proj.alpha").map((d) => d.deliveryId)).toEqual(["fresh"]);
	});

	it("survives a restart, which is the whole reason it is on disk", () => {
		const d = fakeDurable();
		const first = new PendingDeliveryStore(d.store);
		first.enqueue(delivery("d1"));
		first.enqueue(delivery("d2", "proj.beta"));

		const second = new PendingDeliveryStore(d.store);
		expect(second.listForTeam("proj.alpha").map((x) => x.deliveryId)).toEqual(["d1"]);
		expect(second.listForTeam("proj.beta").map((x) => x.deliveryId)).toEqual(["d2"]);
		// And the restored ids still dedupe, or a retry after a restart would deliver twice.
		expect(second.enqueue(delivery("d1"))).toBe("duplicate");
	});

	it("restores the pre-refactor snapshot shape", () => {
		const legacy = { deliveries: [delivery("legacy")] };
		const d = fakeDurable(legacy);
		const restored = new PendingDeliveryStore(d.store);
		expect(restored.snapshot()).toEqual(legacy);
	});

	it("persists on acknowledgement, so a restart cannot resurrect a delivered message", () => {
		const d = fakeDurable();
		const first = new PendingDeliveryStore(d.store);
		first.enqueue(delivery("d1"));
		first.acknowledge("d1");
		expect(new PendingDeliveryStore(d.store).size).toBe(0);
	});

	it("skips a corrupt row instead of trusting or repairing it", () => {
		const d = fakeDurable({
			deliveries: [
				delivery("good"),
				{ deliveryId: "", team: "x", channelJobId: "j", from: "f", body: "b", enqueuedAt: 1 },
				{ deliveryId: "no-team", channelJobId: "j", from: "f", body: "b", enqueuedAt: 1 },
				"not an object",
			],
		});
		const s = new PendingDeliveryStore(d.store);
		expect(s.size).toBe(1);
		expect(s.listForTeam("proj.alpha").map((x) => x.deliveryId)).toEqual(["good"]);
	});

	it("carries the reply anchor and awareness with the message, not around it", () => {
		// Both are needed to deliver later. An anchor rebuilt from live state, or awareness taken at
		// delivery time, would not survive the restart this store exists for.
		const d = fakeDurable();
		const first = new PendingDeliveryStore(d.store);
		const riding = { from: "task-board", body: "an entry changed", act: "no_act" as const };
		first.enqueue({ ...delivery("d1"), awareness: riding, messageId: "bucket-1" });
		const restored = new PendingDeliveryStore(d.store).listForTeam("proj.alpha")[0];
		expect(restored.channelJobId).toBe("job-proj.alpha");
		expect(restored.awareness).toEqual(riding);
		expect(restored.messageId).toBe("bucket-1");
	});
});
