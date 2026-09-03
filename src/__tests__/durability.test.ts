import { describe, expect, it } from "vitest";
import { PendingJobStore } from "../shared/pending-job-store.js";

////////////////////////////////
//  Delivery-state durability
//
//  The gateway snapshots its in-memory delivery state to disk and reloads it on boot so a
// Replies remain pending until delivery.
//  These pin the snapshot/restore round-trips the DurableStore wires to disk.

describe("delivery-state durability", () => {
	it("persistent job anchors (and their stored result) survive snapshot/restore", () => {
		const a = new PendingJobStore<string>();
		a.create("conv:c1:host/team", "Aqua", "host/team", { persistent: true, fromConversationId: "c1" });
		a.deliver("conv:c1:host/team", "hello"); // async (channel) delivery -> stored
		a.create("transient", "x", "y"); // non-persistent: must NOT survive

		const snap = a.snapshot();
		expect(snap.length).toBe(1);
		expect(snap[0].id).toBe("conv:c1:host/team");

		const b = new PendingJobStore<string>();
		b.restore(snap);
		expect(b.poll("conv:c1:host/team")).toBe("hello"); // anchor + result survived
		expect(b.has("transient")).toBe(false);
	});

	it("a restore never clobbers a live entry that beat the load", () => {
		const a = new PendingJobStore<string>();
		a.create("conv:x", "from", "to", { persistent: true });
		a.deliver("conv:x", "old");
		const snap = a.snapshot();

		const b = new PendingJobStore<string>();
		b.create("conv:x", "from", "to", { persistent: true });
		b.deliver("conv:x", "fresh"); // a registration raced the restore
		b.restore(snap);
		expect(b.poll("conv:x")).toBe("fresh"); // the live entry wins
	});
});
