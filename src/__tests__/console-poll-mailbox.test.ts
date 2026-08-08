import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import type { WsData } from "../gateway/websocket.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { frame, makeHarness, OWNER, realTeamWs } from "./helpers/console.js";

describe("createConsoleDispatcher: poll + mailbox lifecycle", () => {
	it("an agent message delivered to the peer is drained by poll", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));

		// Simulate routes.send broadcasting a channel_push to the console as target.
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;
		peer.send(
			JSON.stringify({
				type: "channel_push",
				from: "team-a",
				body: "ping from agent",
				session_id: "conv:team-a:pixel",
			}),
		);

		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const result = reply.result as { entries: { body?: string; kind: string }[]; cursor: number };
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toMatchObject({ kind: "message", body: "ping from agent" });
		expect(result.cursor).toBe(1);
	});

	it("a reply pushed via the conversation registry is drained by poll", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));

		// Simulate routes.respond pushing a response_push to the sender conversation.
		const senderWs = h.conversationRegistry.get("conv-pixel");
		senderWs?.send(
			JSON.stringify({
				type: "response_push",
				session_id: "conv:host:team-a",
				response: "answer",
				status: "completed",
			}),
		);

		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "op3"));
		const result = reply.result as { entries: { body?: string; kind: string }[] };
		expect(result.entries[0]).toMatchObject({ kind: "reply", body: "answer", status: "completed" });
	});

	it("a held poll returns as soon as a message is appended (long-poll)", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;

		const held = h.handler.handleFrame(frame({ kind: "poll", holdMs: 5_000 }, "lp1"));
		await new Promise((r) => setTimeout(r, 20));
		peer.send(JSON.stringify({ type: "response_push", session_id: "s", response: "instant" }));

		const start = Date.now();
		const reply = await held;
		expect(Date.now() - start).toBeLessThan(2_000); // woke on append, not the hold timeout
		const result = reply.result as { entries: { body?: string }[] };
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].body).toBe("instant");
	});

	it("a held poll on an empty mailbox returns empty after the hold elapses", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		const start = Date.now();
		const reply = await h.handler.handleFrame(frame({ kind: "poll", holdMs: 40 }, "lp2"));
		expect(Date.now() - start).toBeGreaterThanOrEqual(30);
		expect((reply.result as { entries: unknown[] }).entries).toHaveLength(0);
	});

	it("poll cursor acks consumed entries", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;
		for (let i = 0; i < 3; i++) {
			peer.send(JSON.stringify({ type: "response_push", session_id: "s", response: `r${i}` }));
		}
		const first = (await h.handler.handleFrame(frame({ kind: "poll" }, "p1"))).result as { cursor: number };
		expect(first.cursor).toBe(3);
		const second = (await h.handler.handleFrame(frame({ kind: "poll", cursor: first.cursor }, "p2"))).result as {
			entries: unknown[];
		};
		expect(second.entries).toHaveLength(0);
	});

	it("removePeer tears down one install; the owner inbox goes with the last device", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		await h.handler.handleFrame(frame({ kind: "register" }, "op2", "pixel", "conv-2"));

		h.handler.removePeer("conv-1");
		expect(h.registry.get("pixel")?.size).toBe(1);
		expect(h.conversationRegistry.get("conv-1")).toBeUndefined();
		// The shared owner inbox survives while conv-2 still uses it.
		expect(h.mailboxStore.get(OWNER)).toBeDefined();

		h.handler.removePeer("conv-2");
		expect(h.registry.get("pixel")).toBeUndefined();
		// Last device gone -> the owner inbox is released.
		expect(h.mailboxStore.get(OWNER)).toBeUndefined();
	});

	it("removePeer never evicts a co-resident real team", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));

		// A real (non-virtual) socket later lands under the same team name.
		const subs = h.registry.get("pixel");
		subs?.set("real-sub", realTeamWs("pixel", "real-sub"));

		h.handler.removePeer("conv-1");
		expect(h.registry.get("pixel")?.size).toBe(1);
		expect(h.registry.get("pixel")?.get("real-sub")).toBeDefined();
	});

	it("TTL sweep evicts the peer together with its mailbox", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));

		const box = h.mailboxStore.get(OWNER);
		if (box) box.lastActivity = Date.now() - 7_200_000;
		h.mailboxStore.sweepExpired();

		expect(h.mailboxStore.get(OWNER)).toBeUndefined();
		expect(h.registry.get("pixel")).toBeUndefined();
		expect(h.conversationRegistry.get("conv-pixel")).toBeUndefined();

		// A fresh register works again afterwards.
		const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op2"));
		expect(reply.ok).toBe(true);
	});

	it("deliveries survive a store-side mailbox recreation (accessor, no orphaned box)", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;

		// Simulate the store entry vanishing out from under a live peer.
		h.mailboxStore.delete(OWNER);
		peer.send(JSON.stringify({ type: "response_push", session_id: "s", response: "after-sweep" }));

		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const result = reply.result as { entries: { body?: string }[] };
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].body).toBe("after-sweep");
	});

	it("a delivery after removePeer does not resurrect an orphan owner inbox", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;

		h.handler.removePeer("conv-pixel"); // last device gone -> owner inbox released
		expect(h.mailboxStore.get(OWNER)).toBeUndefined();

		// A late push to the now-stale peer must not re-create the box (the index would
		// never reap it), so the accessor returns undefined and the append no-ops.
		peer.send(JSON.stringify({ type: "response_push", session_id: "s", response: "late" }));
		expect(h.mailboxStore.get(OWNER)).toBeUndefined();
		expect(h.mailboxStore.size).toBe(0);
	});

	it("poll reports the mailbox epoch and survives an idle-eviction reset", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;
		for (let i = 0; i < 3; i++)
			peer.send(JSON.stringify({ type: "response_push", session_id: "s", response: `r${i}` }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll", cursor: 3 }, "p1"))).result as {
			epoch: number;
			cursor: number;
		};
		expect(first.cursor).toBe(3);

		// The mailbox is evicted (idle) and a new instance is created on the next frame.
		const box = h.mailboxStore.get(OWNER);
		if (box) box.lastActivity = Date.now() - 7_200_000;
		h.mailboxStore.sweepExpired();

		const peer2 = h.handler.ensurePeer("pixel", "conv-pixel", "signer-conv-pixel", OWNER);
		peer2.send(JSON.stringify({ type: "response_push", session_id: "s", response: "post-reset" }));

		// A stale cursor (3) must NOT ack away the new instance's seq=1 entry.
		const after = (await h.handler.handleFrame(frame({ kind: "poll", cursor: 3 }, "p2"))).result as {
			entries: { body?: string }[];
			epoch: number;
		};
		expect(after.epoch).not.toBe(first.epoch);
		expect(after.entries).toHaveLength(1);
		expect(after.entries[0].body).toBe("post-reset");
	});
});

describe("DeviceMailboxStore caps", () => {
	it("LRU-evicts the least-recently-active mailbox beyond maxDevices, firing onEvict", () => {
		const store = new DeviceMailboxStore({ maxDevices: 2 });
		const evicted: string[] = [];
		store.setOnEvict((d) => evicted.push(d));

		const a = store.ensure("a");
		a.lastActivity = 1;
		const b = store.ensure("b");
		b.lastActivity = 2;
		store.ensure("c"); // exceeds cap -> evicts "a" (oldest)

		expect(store.size).toBe(2);
		expect(store.get("a")).toBeUndefined();
		expect(store.get("b")).toBeDefined();
		expect(store.get("c")).toBeDefined();
		expect(evicted).toEqual(["a"]);
	});

	it("a fresh instance gets a new epoch", () => {
		// Epochs are random (the console compares them only for equality), so the
		// contract is "different", not "greater".
		const store = new DeviceMailboxStore();
		const e1 = store.ensure("x").epoch;
		store.delete("x");
		const e2 = store.ensure("x").epoch;
		expect(e2).not.toBe(e1);
	});
});
