import { describe, expect, it } from "vitest";
import type { MailboxInput } from "../shared/console-protocol.js";
import { DeviceMailbox, DeviceMailboxStore } from "../shared/device-mailbox.js";

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

	it("cap eviction prefers the oldest peer entry over older entries of other kinds", () => {
		const box = new DeviceMailbox(1, 3);
		box.append(message("s1", "m0"));
		box.append({ kind: "peer", session_id: "s1", from: "a", to: "b", body: "chatter" });
		box.append(message("s1", "m1"));
		// Appending past the cap would normally evict "m0" (oldest overall); instead the
		// "peer" entry is evicted first even though it is newer, so real mail survives longer.
		box.append(message("s1", "m2"));
		const snap = box.drain(0);
		expect(snap.entries.map((e) => e.body)).toEqual(["m0", "m1", "m2"]);
		expect(snap.dropped).toBe(1);
	});

	it("a peer entry that itself tips the cap does not evict itself", () => {
		const box = new DeviceMailbox(1, 3);
		box.append(message("s1", "m0"));
		box.append(message("s1", "m1"));
		box.append(message("s1", "m2"));
		// The backlog is entirely non-peer; this fresh "peer" append is the only "peer"
		// entry in the array. It must not be its own eviction candidate - "m0" (the oldest
		// non-peer entry) should go instead, or the mirror silently blinds itself on arrival.
		box.append({ kind: "peer", session_id: "s1", from: "a", to: "b", body: "chatter" });
		const snap = box.drain(0);
		expect(snap.entries.map((e) => e.body)).toEqual(["m1", "m2", "chatter"]);
		expect(snap.dropped).toBe(1);
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
		// The gateway-restart trap: if a new instance ever minted an epoch the
		// console still held, the console's stale (larger) cursor must not be able to
		// ack away entries this instance never issued.
		const box = new DeviceMailbox(7);
		box.append(message("s1", "fresh-1"));
		box.append(message("s1", "fresh-2"));
		const stale = box.drain(47, 7);
		expect(stale.entries.map((e) => e.body)).toEqual(["fresh-1", "fresh-2"]);
		expect(stale.cursor).toBe(2);
	});

	/** An entry weighing [bytes], via the body. Prose is what the cap measures now: an attachment
	 * contributes only its name and reference, since the bytes themselves are not in the mailbox. */
	function heavyMessage(session_id: string, bytes: number): MailboxInput {
		return { kind: "reply", session_id, body: "x".repeat(bytes) };
	}

	it("byte cap evicts oldest entries and counts them in dropped", () => {
		const box = new DeviceMailbox(1, 100, 100);
		box.append(heavyMessage("s1", 40));
		box.append(heavyMessage("s1", 40));
		box.append(heavyMessage("s1", 40)); // now 120 bytes > 100, oldest evicted
		const snap = box.drain(0);
		expect(snap.entries.length).toBe(2);
		expect(snap.dropped).toBe(1);
	});

	it("byte cap always keeps the just-appended entry even if it alone exceeds the cap", () => {
		const box = new DeviceMailbox(1, 100, 50);
		box.append(heavyMessage("s1", 200)); // single oversized entry (backstop only)
		const snap = box.drain(0);
		expect(snap.entries.length).toBe(1);
	});

	it("an attachment weighs its reference, not its contents", () => {
		// The whole point of the blob plane: a mailbox holding a 4 GB video costs the same as one
		// holding a 4 KB note, so a few large attachments can never evict real unread mail. A 1 KB
		// cap against ten 4 GB files is only survivable because the accounting counts the name and
		// the digest; under the old base64 accounting the first entry alone would have evicted.
		const box = new DeviceMailbox(10, 100, 1_000);
		const withFile = (size: number): MailboxInput => ({
			kind: "reply",
			session_id: "s1",
			files: [
				{
					filename: "a.bin",
					mime: "application/octet-stream",
					size,
					descriptiveKey: "a.bin",
					blobId: `sha256-${"b".repeat(64)}`,
				},
			],
		});
		for (let i = 0; i < 10; i++) box.append(withFile(4_000_000_000));
		const snap = box.drain(0);
		expect(snap.entries.length).toBe(10);
		expect(snap.dropped).toBe(0);
	});

	it("ack keeps the byte accounting in sync so later appends do not over-evict", () => {
		const box = new DeviceMailbox(1, 100, 100);
		box.append(heavyMessage("s1", 40));
		box.append(heavyMessage("s1", 40));
		box.drain(2, 1); // ack both, freeing their bytes
		// A fresh pair fits because the acked bytes were reclaimed.
		box.append(heavyMessage("s1", 40));
		box.append(heavyMessage("s1", 40));
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
		// Simulates an gateway restart with a console that kept running: the new
		// store's mailbox must carry an epoch the console cannot already hold, or
		// the console never detects the new instance and goes silently deaf. A
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
		box.drain(2, 1, "consoleA"); // ack up to seq 2 on the watermark path
		expect(box.size).toBe(1); // seq 3 retained, 1 and 2 compacted
		expect(box.drain(0).dropped).toBe(0); // watermark trim is not a gap
	});

	it("trims only to the slowest of several devices", () => {
		const box = new DeviceMailbox(1);
		for (const b of ["a", "b", "c", "d", "e"]) box.append(message("s1", b));
		box.advanceConsumer("consoleA", 5); // caught up
		box.advanceConsumer("consoleB", 2); // slow
		expect(box.minCursor()).toBe(2);
		box.trimToMinCursor();
		expect(box.size).toBe(3); // seq 3,4,5 retained for the slow console
		expect(box.drain(0).dropped).toBe(0);
	});

	it("a freshly-joined consumer's unacked mail is not trimmed by a sibling's ack", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "r1"));
		// Device B's first poll (cursor 0) receives r1 but acks nothing yet.
		expect(box.drain(0, 1, "B").entries.map((e) => e.body)).toEqual(["r1"]);
		// Device A drains and acks r1. Without B's floor registered, this would trim r1.
		box.drain(1, 1, "A");
		// r1 is retained for B and re-handed on its retry, with no dropped-gap.
		const b2 = box.drain(0, 1, "B");
		expect(b2.entries.map((e) => e.body)).toEqual(["r1"]);
		expect(b2.dropped).toBe(0);
	});

	it("forgetting the slow device advances the watermark", () => {
		const box = new DeviceMailbox(1);
		for (const b of ["a", "b", "c", "d", "e"]) box.append(message("s1", b));
		box.advanceConsumer("consoleA", 5);
		box.advanceConsumer("consoleB", 2);
		box.forgetConsumer("consoleB"); // slow device evicted past its TTL
		expect(box.minCursor()).toBe(5);
		box.trimToMinCursor();
		expect(box.size).toBe(0);
	});

	it("advanceConsumer is monotonic (a stale lower ack cannot rewind)", () => {
		const box = new DeviceMailbox(1);
		box.advanceConsumer("consoleA", 5);
		box.advanceConsumer("consoleA", 3); // out-of-order/stale
		expect(box.minCursor()).toBe(5);
	});

	it("consumerCursors survive a snapshot/restore round trip", () => {
		const box = new DeviceMailbox(9);
		for (const b of ["a", "b", "c"]) box.append(message("s1", b));
		box.advanceConsumer("consoleA", 3);
		box.advanceConsumer("consoleB", 1);
		const restored = DeviceMailbox.fromSnapshot(box.snapshot());
		expect(restored.minCursor()).toBe(1); // the slow console still pins it
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
		// After a restart the console can still respond to a thread it received before.
		expect(restored.canRespond("conv:a:host/team")).toBe(true);
		expect(restored.canRespond("conv:b:host/team")).toBe(true);
		expect(restored.canRespond("conv:never:host/team")).toBe(false);
	});
});

describe("DeviceMailbox idle-consumer sweep", () => {
	it("forgets nothing while every consumer is recent", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "a"));
		box.drain(1, 1, "consoleA");
		expect(box.sweepIdleConsumers(Date.now(), 60_000)).toBe(0);
		expect(box.minCursor()).toBe(1);
	});

	it("releases a dead consumer while keeping a recently active one, resuming compaction", async () => {
		const box = new DeviceMailbox(1);
		for (const b of ["a", "b", "c", "d", "e"]) box.append(message("s1", b));
		box.drain(2, 1, "consoleB"); // slow; about to go silent, pins minCursor at 2
		await new Promise((r) => setTimeout(r, 30));
		box.drain(5, 1, "consoleA"); // active, caught up
		// ttl shorter than B's idle gap (~30ms) but longer than A's (~0ms): only B goes.
		expect(box.sweepIdleConsumers(Date.now(), 15)).toBe(1);
		expect(box.minCursor()).toBe(5); // A is now the slowest live consumer
		expect(box.size).toBe(0); // sweep re-trims once the dead consumer is released
	});

	it("a forgotten consumer is re-tracked on its next poll", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "a"));
		box.drain(1, 1, "consoleA");
		expect(box.sweepIdleConsumers(Date.now() + 120_000, 60_000)).toBe(1);
		// It comes back: a fresh poll re-registers its cursor and idle clock.
		box.append(message("s1", "b"));
		box.drain(2, 1, "consoleA");
		expect(box.minCursor()).toBe(2);
		expect(box.sweepIdleConsumers(Date.now(), 60_000)).toBe(0);
	});

	it("a cursor-0 first poll registers the idle clock without a watermark", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "a"));
		box.drain(0, 1, "consoleA"); // first poll: marks alive but acks nothing
		expect(box.minCursor()).toBe(0); // no watermark cursor registered yet
		// The idle clock WAS registered, so a far-future sweep still forgets it.
		expect(box.sweepIdleConsumers(Date.now() + 120_000, 60_000)).toBe(1);
	});

	it("forgetConsumer clears the idle clock too, so a later sweep does not re-forget it", () => {
		const box = new DeviceMailbox(1);
		box.append(message("s1", "a"));
		box.drain(1, 1, "consoleA"); // sets both the cursor and the idle clock
		box.forgetConsumer("consoleA");
		expect(box.sweepIdleConsumers(Date.now() + 120_000, 60_000)).toBe(0);
	});

	it("snapshot writes consumerLastSeen and fromSnapshot honors it over the seed fallback", () => {
		const box = new DeviceMailbox(3);
		box.append(message("s1", "a"));
		box.drain(1, 3, "consoleA"); // sets the cursor and the idle clock
		const snap = box.snapshot();
		expect(snap.consumerLastSeen?.some(([k]) => k === "consoleA")).toBe(true);
		// Diverge the persisted clock (ancient) from lastActivity (now). If fromSnapshot
		// honors the persisted value, consoleA is idle and gets forgotten; if it wrongly
		// seeded from lastActivity it would look fresh and survive. Asserting it is
		// forgotten pins the round-trip, which an equal lastSeen==lastActivity could not.
		snap.consumerLastSeen = [["consoleA", 1000]];
		snap.lastActivity = Date.now();
		const restored = DeviceMailbox.fromSnapshot(snap);
		expect(restored.sweepIdleConsumers(Date.now(), 3_600_000)).toBe(1);
	});

	it("an older snapshot without consumerLastSeen seeds the clock from lastActivity", () => {
		const box = new DeviceMailbox(3);
		box.append(message("s1", "a"));
		box.advanceConsumer("consoleA", 1);
		const snap = box.snapshot();
		snap.consumerLastSeen = undefined; // simulate a pre-upgrade snapshot
		const restored = DeviceMailbox.fromSnapshot(snap);
		// Seeded ~now, so not idle yet, but idle far in the future.
		expect(restored.sweepIdleConsumers(Date.now(), 60_000)).toBe(0);
		expect(restored.sweepIdleConsumers(Date.now() + 120_000, 60_000)).toBe(1);
	});
});

describe("DeviceMailboxStore idle-consumer sweep", () => {
	it("sweepExpired releases idle consumers on a still-live inbox", async () => {
		const store = new DeviceMailboxStore({ ttlMs: 20 });
		const box = store.ensure("ownerX");
		box.append(message("s1", "a"));
		box.append(message("s1", "b"));
		box.drain(1, box.epoch, "consoleB"); // slow; will go idle
		await new Promise((r) => setTimeout(r, 40));
		box.drain(2, box.epoch, "consoleA"); // active
		box.touch(); // keep the whole inbox alive so it is not evicted outright
		expect(store.sweepExpired()).toBe(0); // box itself not expired
		expect(store.get("ownerX")).toBe(box);
		expect(box.minCursor()).toBe(2); // consoleB forgotten, consoleA is the watermark
	});
});
