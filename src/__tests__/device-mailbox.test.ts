import { describe, expect, it } from "vitest";
import { DeviceMailbox, DeviceMailboxStore } from "../shared/device-mailbox.js";
import type { MailboxInput } from "../shared/phone-protocol.js";

function message(session_id: string, body: string): MailboxInput {
	return { kind: "message", session_id, from: "team-a", body };
}

describe("DeviceMailbox", () => {
	it("append assigns monotonic seq and advances highWater", () => {
		const box = new DeviceMailbox(1);
		expect(box.highWater).toBe(0);
		const a = box.append(message("s1", "hi"));
		const b = box.append(message("s1", "there"));
		expect(a.seq).toBe(1);
		expect(b.seq).toBe(2);
		expect(box.highWater).toBe(2);
		expect(box.size).toBe(2);
	});

	it("drain from cursor 0 returns all entries without dropping them", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "one"));
		box.append(message("s1", "two"));
		const first = box.drain(0);
		expect(first.entries.map((e) => e.body)).toEqual(["one", "two"]);
		expect(first.cursor).toBe(2);
		// Not acked yet: a re-drain at cursor 0 still sees them (at-least-once).
		const again = box.drain(0);
		expect(again.entries.length).toBe(2);
	});

	it("drain acks entries at or below the supplied cursor", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "one"));
		box.append(message("s1", "two"));
		box.append(message("s1", "three"));
		const snap = box.drain(2);
		expect(snap.entries.map((e) => e.body)).toEqual(["three"]);
		expect(snap.cursor).toBe(3);
		expect(box.size).toBe(1);
	});

	it("cap evicts oldest and dropped is a sticky cumulative total", () => {
		const box = new DeviceMailbox(1, 3);
		for (let i = 0; i < 5; i++) box.append(message("s1", `m${i}`));
		expect(box.size).toBe(3);
		const snap = box.drain(0);
		expect(snap.entries.map((e) => e.body)).toEqual(["m2", "m3", "m4"]);
		expect(snap.dropped).toBe(2);
		// Cumulative: a lost poll response cannot hide the gap.
		expect(box.drain(0).dropped).toBe(2);
		box.append(message("s1", "m5"));
		box.append(message("s1", "m6"));
		expect(box.drain(0).dropped).toBe(4);
	});

	it("epoch-gated drain does not ack a cursor from a different epoch", () => {
		const box = new DeviceMailbox(2); // a recreated instance, epoch 2
		box.append(message("s1", "new-1"));
		box.append(message("s1", "new-2"));
		box.append(message("s1", "new-3"));
		// Stale cursor 3 carried from epoch 1 must not ack the new instance.
		const stale = box.drain(3, 1);
		expect(stale.entries.map((e) => e.body)).toEqual(["new-1", "new-2", "new-3"]);
		expect(stale.epoch).toBe(2);
		// A matching epoch acks normally.
		const fresh = box.drain(2, 2);
		expect(fresh.entries.map((e) => e.body)).toEqual(["new-3"]);
	});

	it("epoch-omitted drain falls back to a magnitude guard at the boundary", () => {
		const box = new DeviceMailbox(2);
		box.append(message("s1", "a"));
		box.append(message("s1", "b"));
		box.append(message("s1", "c"));
		// cursor==highWater with no epoch still acks (legitimate in-order poll).
		expect(box.drain(3).entries).toHaveLength(0);
	});

	it("ack on empty or below-floor cursor is a no-op", () => {
		const box = new DeviceMailbox(1);
		box.ack(5);
		box.append(message("s1", "one"));
		box.ack(0);
		expect(box.size).toBe(1);
	});

	it("isExpired compares against lastActivity", () => {
		const box = new DeviceMailbox(1);
		const base = box.lastActivity;
		expect(box.isExpired(base + 1000, 5000)).toBe(false);
		expect(box.isExpired(base + 6000, 5000)).toBe(true);
		box.touch();
		expect(box.isExpired(box.lastActivity + 1000, 5000)).toBe(false);
	});
});

describe("DeviceMailboxStore", () => {
	it("ensure is idempotent and get/delete work", () => {
		const store = new DeviceMailboxStore();
		const a = store.ensure("pixel");
		const b = store.ensure("pixel");
		expect(a).toBe(b);
		expect(store.size).toBe(1);
		expect(store.get("pixel")).toBe(a);
		store.delete("pixel");
		expect(store.get("pixel")).toBeUndefined();
		expect(store.size).toBe(0);
	});

	it("sweepExpired removes only idle mailboxes", () => {
		const store = new DeviceMailboxStore({ ttlMs: 1000 });
		const fresh = store.ensure("fresh");
		const stale = store.ensure("stale");
		stale.lastActivity = Date.now() - 5000;
		const removed = store.sweepExpired();
		expect(removed).toBe(1);
		expect(store.get("stale")).toBeUndefined();
		expect(store.get("fresh")).toBe(fresh);
	});

	it("sweepExpired fires onEvict for each evicted mailbox", () => {
		const store = new DeviceMailboxStore({ ttlMs: 1000 });
		const evicted: string[] = [];
		store.setOnEvict((device) => evicted.push(device));
		store.ensure("gone").lastActivity = Date.now() - 5000;
		store.ensure("kept");
		store.sweepExpired();
		expect(evicted).toEqual(["gone"]);
		expect(store.get("kept")).toBeDefined();
	});
});
