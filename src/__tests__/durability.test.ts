import { describe, expect, it } from "vitest";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { PendingJobStore } from "../shared/pending-job-store.js";

////////////////////////////////
//  Delivery-state durability
//
//  The arbiter snapshots its in-memory delivery state to disk and reloads it on boot so a
//  restart/deploy no longer 404s a reply ("no pending request") or loses queued mail.
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

	it("mailbox boxes survive snapshot/restore keeping epoch, seq, and entries", () => {
		const a = new DeviceMailboxStore();
		const box = a.ensure("phone-1");
		box.append({ kind: "reply", session_id: "s", body: "hi" });
		box.append({ kind: "reply", session_id: "s", body: "there" });
		const epoch = box.epoch;
		const hw = box.highWater;

		const snap = a.snapshot();
		const b = new DeviceMailboxStore();
		b.restore(snap);

		const r = b.get("phone-1");
		expect(r).toBeDefined();
		expect(r?.epoch).toBe(epoch); // epoch preserved -> no spurious flip on the phone
		expect(r?.highWater).toBe(hw); // seq preserved -> no re-seen entries
		const drained = r?.drain(0, epoch);
		expect(drained?.entries.map((e) => e.body)).toEqual(["hi", "there"]); // entries survived
	});
});
