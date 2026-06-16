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

	it("a cursor beyond highWater never acks, even when the epoch matches", () => {
		// The arbiter-restart trap: if a new instance ever minted an epoch the
		// phone still held, the phone's stale (larger) cursor must not be able to
		// ack away entries this instance never issued.
		const box = new DeviceMailbox(7);
		box.append(message("s1", "fresh-1"));
		box.append(message("s1", "fresh-2"));
		const stale = box.drain(47, 7);
		expect(stale.entries.map((e) => e.body)).toEqual(["fresh-1", "fresh-2"]);
		expect(stale.cursor).toBe(2);
	});

	// No body, so the byte estimate is exactly the base64 length per entry.
	function fileMessage(session_id: string, base64: string): MailboxInput {
		return {
			kind: "reply",
			session_id,
			files: [
				{
					filename: "a.bin",
					mime: "application/octet-stream",
					size: base64.length,
					descriptiveKey: "a.bin",
					base64,
				},
			],
		};
	}

	it("byte cap evicts oldest file-bearing entries and counts them in dropped", () => {
		// 100-byte byte cap; each entry carries ~40 bytes of base64.
		const box = new DeviceMailbox(1, 100, 100);
		const big = "x".repeat(40);
		box.append(fileMessage("s1", big));
		box.append(fileMessage("s1", big));
		box.append(fileMessage("s1", big)); // now ~120 bytes > 100, oldest evicted
		const snap = box.drain(0);
		expect(snap.entries.length).toBe(2);
		expect(snap.dropped).toBe(1);
	});

	it("byte cap always keeps the just-appended entry even if it alone exceeds the cap", () => {
		const box = new DeviceMailbox(1, 100, 50);
		box.append(fileMessage("s1", "x".repeat(200))); // single oversized entry (backstop only)
		const snap = box.drain(0);
		expect(snap.entries.length).toBe(1);
	});

	it("ack keeps the byte accounting in sync so later appends do not over-evict", () => {
		const box = new DeviceMailbox(1, 100, 100);
		const big = "x".repeat(40);
		box.append(fileMessage("s1", big));
		box.append(fileMessage("s1", big));
		box.drain(2, 1); // ack both, freeing their bytes
		// A fresh pair fits because the acked bytes were reclaimed.
		box.append(fileMessage("s1", big));
		box.append(fileMessage("s1", big));
		expect(box.drain(0).entries.length).toBe(2);
		expect(box.drain(0).dropped).toBe(0);
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

	it("waitForAppend resolves when an entry is appended", async () => {
		const box = new DeviceMailbox(1);
		let resolved = false;
		const wait = box.waitForAppend(5_000).then(() => {
			resolved = true;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(false);
		box.append({ kind: "message", session_id: "s", body: "wake up" });
		await wait;
		expect(resolved).toBe(true);
		expect(box.drain().entries).toHaveLength(1);
	});

	it("waitForAppend resolves on timeout when nothing arrives", async () => {
		const box = new DeviceMailbox(1);
		const start = Date.now();
		await box.waitForAppend(30);
		expect(Date.now() - start).toBeGreaterThanOrEqual(25);
		expect(box.drain().entries).toHaveLength(0);
	});

	it("releaseWaiters wakes every held poll (store teardown path)", async () => {
		const box = new DeviceMailbox(1);
		const waits = [box.waitForAppend(60_000), box.waitForAppend(60_000)];
		box.releaseWaiters();
		await Promise.all(waits); // resolves promptly, not after a minute
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

	it("a recreated store mints a different epoch for the same device", () => {
		// Simulates an arbiter restart with a phone that kept running: the new
		// store's mailbox must carry an epoch the phone cannot already hold, or
		// the phone never detects the new instance and goes silently deaf. A
		// deterministic counter base re-minted colliding epochs across restarts.
		const before = new DeviceMailboxStore().ensure("aqua").epoch;
		const after = new DeviceMailboxStore().ensure("aqua").epoch;
		expect(after).not.toBe(before);
		expect(before).toBeGreaterThan(0);
		expect(after).toBeLessThanOrEqual(0x7fffffff);
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

describe("DeviceMailbox idempotent dedupeKey upsert", () => {
	it("a repeat dedupeKey does not append a duplicate and returns the original seq", () => {
		const box = new DeviceMailbox(1);
		const a = box.append(message("s1", "hi"), "op-1");
		const b = box.append(message("s1", "hi"), "op-1");
		expect(a.seq).toBe(1);
		expect(b.seq).toBe(1);
		expect(box.size).toBe(1);
		expect(box.highWater).toBe(1);
	});

	it("distinct dedupeKeys append distinct entries", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "a"), "op-1");
		box.append(message("s1", "b"), "op-2");
		expect(box.size).toBe(2);
		expect(box.highWater).toBe(2);
	});

	it("appends without a dedupeKey are never deduped", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "a"));
		box.append(message("s1", "a"));
		expect(box.size).toBe(2);
	});

	it("a retry is still deduped after the original was acked and removed", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "hi"), "op-1");
		box.drain(1, 1); // ack seq 1, removes the entry
		expect(box.size).toBe(0);
		const retry = box.append(message("s1", "hi"), "op-1");
		expect(retry.seq).toBe(1); // the original seq, not a fresh one
		expect(box.size).toBe(0); // not re-appended
		expect(box.highWater).toBe(1); // nextSeq did not advance
	});

	it("dedup survives a snapshot/restore round trip", () => {
		const box = new DeviceMailbox(7);
		box.append(message("s1", "hi"), "op-1");
		const restored = DeviceMailbox.fromSnapshot(box.snapshot());
		const retry = restored.append(message("s1", "hi"), "op-1");
		expect(retry.seq).toBe(1);
		expect(restored.size).toBe(1); // still just the one entry
		expect(restored.highWater).toBe(1);
	});
});

describe("DeviceMailbox slowest-device watermark", () => {
	it("minCursor is 0 with no registered device (trim nothing)", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "a"));
		expect(box.minCursor()).toBe(0);
		box.trimToMinCursor();
		expect(box.size).toBe(1);
	});

	it("a single device drain via consumerId trims to that device's cursor", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "a"));
		box.append(message("s1", "b"));
		box.append(message("s1", "c"));
		box.drain(2, 1, "phoneA"); // ack up to seq 2 on the watermark path
		expect(box.size).toBe(1); // seq 3 retained, 1 and 2 compacted
		expect(box.drain(0).dropped).toBe(0); // watermark trim is not a gap
	});

	it("trims only to the slowest of several devices", () => {
		const box = new DeviceMailbox(1);
		for (const b of ["a", "b", "c", "d", "e"]) box.append(message("s1", b));
		box.advanceConsumer("phoneA", 5); // caught up
		box.advanceConsumer("phoneB", 2); // slow
		expect(box.minCursor()).toBe(2);
		box.trimToMinCursor();
		expect(box.size).toBe(3); // seq 3,4,5 retained for the slow phone
		expect(box.drain(0).dropped).toBe(0);
	});

	it("forgetting the slow device advances the watermark", () => {
		const box = new DeviceMailbox(1);
		for (const b of ["a", "b", "c", "d", "e"]) box.append(message("s1", b));
		box.advanceConsumer("phoneA", 5);
		box.advanceConsumer("phoneB", 2);
		box.forgetConsumer("phoneB"); // slow device evicted past its TTL
		expect(box.minCursor()).toBe(5);
		box.trimToMinCursor();
		expect(box.size).toBe(0);
	});

	it("advanceConsumer is monotonic (a stale lower ack cannot rewind)", () => {
		const box = new DeviceMailbox(1);
		box.advanceConsumer("phoneA", 5);
		box.advanceConsumer("phoneA", 3); // out-of-order/stale
		expect(box.minCursor()).toBe(5);
	});

	it("consumerCursors survive a snapshot/restore round trip", () => {
		const box = new DeviceMailbox(9);
		for (const b of ["a", "b", "c"]) box.append(message("s1", b));
		box.advanceConsumer("phoneA", 3);
		box.advanceConsumer("phoneB", 1);
		const restored = DeviceMailbox.fromSnapshot(box.snapshot());
		expect(restored.minCursor()).toBe(1); // the slow phone still pins it
		restored.trimToMinCursor();
		expect(restored.size).toBe(2); // seq 2,3 retained
	});
});

describe("DeviceMailbox durable respondability", () => {
	it("records and checks respondable sessions", () => {
		const box = new DeviceMailbox(1);
		expect(box.canRespond("conv:x:host/team")).toBe(false);
		box.recordSession("conv:x:host/team");
		expect(box.canRespond("conv:x:host/team")).toBe(true);
	});

	it("respondability survives a snapshot/restore (the class-10 fix)", () => {
		const box = new DeviceMailbox(5);
		box.recordSession("conv:a:host/team");
		box.recordSession("conv:b:host/team");
		const restored = DeviceMailbox.fromSnapshot(box.snapshot());
		// After a restart the phone can still respond to a thread it received before.
		expect(restored.canRespond("conv:a:host/team")).toBe(true);
		expect(restored.canRespond("conv:b:host/team")).toBe(true);
		expect(restored.canRespond("conv:never:host/team")).toBe(false);
	});
});
