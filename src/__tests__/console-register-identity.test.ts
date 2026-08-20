import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { ConsolePeer } from "../gateway/console/consolePeer.js";
import type { ConversationRegistry, TeamRegistry, WsData } from "../gateway/websocket.js";
import { DeviceMailbox, DeviceMailboxStore } from "../shared/device-mailbox.js";
import { frame, jsonRes, makeHarness, OWNER, realTeamWs } from "./helpers/console.js";

describe("ConsolePeer", () => {
	it("channel_push lands as a message entry", () => {
		const box = new DeviceMailbox(1);
		const peer = new ConsolePeer(() => box, "pixel", "conv-pixel", "conv-pixel");
		peer.send(
			JSON.stringify({
				type: "channel_push",
				from: "team-a",
				body: "need a hand",
				session_id: "conv:team-a:pixel",
			}),
		);
		const snap = box.drain(0);
		expect(snap.entries).toHaveLength(1);
		expect(snap.entries[0]).toMatchObject({ kind: "message", from: "team-a", body: "need a hand" });
	});

	it("response_push lands as a reply entry", () => {
		const box = new DeviceMailbox(1);
		const peer = new ConsolePeer(() => box, "pixel", "conv-pixel", "conv-pixel");
		peer.send(
			JSON.stringify({
				type: "response_push",
				session_id: "conv:host:team-a",
				response: "done",
				status: "completed",
			}),
		);
		const snap = box.drain(0);
		expect(snap.entries[0]).toMatchObject({ kind: "reply", body: "done", status: "completed" });
	});

	it("non-delivery frame types and garbage are ignored", () => {
		const box = new DeviceMailbox(1);
		const peer = new ConsolePeer(() => box, "pixel", "conv-pixel", "conv-pixel");
		peer.send("not json");
		peer.send(JSON.stringify({ type: "evie_tools", tools: [] }));
		expect(box.size).toBe(0);
	});
});

describe("createConsoleDispatcher: register + identity", () => {
	it("register inserts a virtual peer keyed by conversationId and returns the cursor", async () => {
		const h = makeHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "register" }));
		expect(reply.ok).toBe(true);
		// register hands back the connected Gateway id so the console anchors its
		// composite (gatewayId, name) key and migrates bare-keyed threads onto it.
		expect(reply.result).toMatchObject({ device: "pixel", gatewayId: "test-host", cursor: 0 });
		expect((reply.result as { epoch: number }).epoch).toBeGreaterThan(0);

		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;
		expect(peer).toBeDefined();
		expect(peer.data.virtual).toBe(true);
		expect(peer.data.mode).toBe("channel");
		expect(h.conversationRegistry.get("conv-pixel")).toBe(peer);
	});

	it("register carries the Gateway's domainStatus so the app knows to first-root vs provision", async () => {
		const h = makeHarness({}, { domainStatus: () => "pending" });
		const reply = await h.handler.handleFrame(frame({ kind: "register" }));
		expect(reply.ok).toBe(true);
		expect(reply.result).toMatchObject({ device: "pixel", domainStatus: "pending" });
	});

	it("register OMITS domainStatus when the Gateway has none (legacy already-rooted path)", async () => {
		const h = makeHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "register" }));
		expect(reply.ok).toBe(true);
		expect(reply.result).not.toHaveProperty("domainStatus");
	});

	it("register DROPS a garbage domainStatus (boundary-validated against the closed union)", async () => {
		const h = makeHarness({}, { domainStatus: () => "bogus" });
		const reply = await h.handler.handleFrame(frame({ kind: "register" }));
		expect(reply.ok).toBe(true);
		expect(reply.result).not.toHaveProperty("domainStatus");
	});

	it("rejects a first_root op: it is decided at the Router, never through a Gateway", async () => {
		const h = makeHarness();
		const firstRoot = {
			kind: "first_root" as const,
			firstRoot: {
				firstRoot: {
					domainId: "carol",
					ownerSignPub: "spub",
					ownerBoxPub: "bpub",
					nonce: "bm9uY2U=",
					issuedAt: 1,
				},
				signature: "sig",
			},
		};
		const reply = await h.handler.handleFrame(frame(firstRoot));
		expect(reply.ok).toBe(false);
	});

	it("rejects the reserved host-daemon device name", async () => {
		const h = makeHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op1", "host", "conv-host"));
		expect(reply.ok).toBe(false);
		expect(h.registry.get("host")).toBeUndefined();
	});

	it("rejects a device name that matches a devcontainer project, even a sleeping one", async () => {
		// Without this, a console named after a sleeping catalog project squats its
		// registry slot: teams() shows it online, sends land in the console mailbox,
		// and the real project's wake is suppressed.
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const mailboxStore = new DeviceMailboxStore();
		const handler = createConsoleDispatcher({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			},
			isProjectName: (name) => name === "recipe-app",
		});

		const reply = await handler.handleFrame(frame({ kind: "register" }, "op1", "recipe-app", "conv-x"));
		expect(reply.ok).toBe(false);
		expect(registry.get("recipe-app")).toBeUndefined();
	});

	it("rejects a device name already held by a real team", async () => {
		const h = makeHarness();
		const subs = new Map([["abc123", realTeamWs("team-a", "abc123")]]);
		h.registry.set("team-a", subs);

		const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op1", "team-a", "conv-x"));
		expect(reply.ok).toBe(false);
		expect(h.registry.get("team-a")).toBe(subs);
		expect(subs.size).toBe(1);
	});

	it("two installs of one owner share the owner inbox but keep separate subs", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		await h.handler.handleFrame(frame({ kind: "register" }, "op2", "pixel", "conv-2"));

		const subs = h.registry.get("pixel");
		expect(subs?.size).toBe(2);
		// One owner -> one shared inbox, not one box per install.
		expect(h.mailboxStore.size).toBe(1);
		expect(h.mailboxStore.get(OWNER)).toBeDefined();
	});

	it("a reply appended once to the owner inbox is drained by every device of that owner", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		await h.handler.handleFrame(frame({ kind: "register" }, "op2", "tablet", "conv-2", "signer-conv-2"));

		// The agent's reply lands once in the shared owner inbox.
		h.mailboxStore.get(OWNER)?.append({ kind: "reply", session_id: "s", body: "answer" });

		const a = (await h.handler.handleFrame(frame({ kind: "poll" }, "pa", "pixel", "conv-1"))).result as {
			entries: { body?: string }[];
		};
		const b = (await h.handler.handleFrame(frame({ kind: "poll" }, "pb", "tablet", "conv-2", "signer-conv-2")))
			.result as { entries: { body?: string }[] };
		// Both phones see it, each draining with its own cursor.
		expect(a.entries.map((e) => e.body)).toEqual(["answer"]);
		expect(b.entries.map((e) => e.body)).toEqual(["answer"]);
	});

	it("a different owner gets a separate inbox and never sees another owner's reply", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		await h.handler.handleFrame(frame({ kind: "register" }, "op2", "nexus", "conv-2", "signer-conv-2", "owner-2"));
		expect(h.mailboxStore.size).toBe(2);

		h.mailboxStore.get(OWNER)?.append({ kind: "reply", session_id: "s", body: "for-owner-1" });

		const poll2 = (
			await h.handler.handleFrame(frame({ kind: "poll" }, "p2", "nexus", "conv-2", "signer-conv-2", "owner-2"))
		).result as { entries: unknown[] };
		expect(poll2.entries).toHaveLength(0);
	});

	it("a send mirrors a `sent` echo to the owner inbox for every device of the owner", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		await h.handler.handleFrame(frame({ kind: "register" }, "op2", "tablet", "conv-2", "signer-conv-2"));

		await h.handler.handleFrame(frame({ kind: "send", to: "team-a", body: "hi all" }, "send-1", "pixel", "conv-1"));

		// The sending device sees its own echo, tagged with the originating opId so it can
		// reconcile its optimistic row instead of double-rendering.
		const a = (await h.handler.handleFrame(frame({ kind: "poll" }, "pa", "pixel", "conv-1"))).result as {
			entries: { kind: string; body?: string; opId?: string }[];
		};
		expect(a.entries.at(-1)).toMatchObject({ kind: "sent", body: "hi all", opId: "send-1" });
		// The owner's other device sees the same outgoing message.
		const b = (await h.handler.handleFrame(frame({ kind: "poll" }, "pb", "tablet", "conv-2", "signer-conv-2")))
			.result as { entries: { kind: string; body?: string }[] };
		expect(b.entries.some((e) => e.kind === "sent" && e.body === "hi all")).toBe(true);
	});

	it("list_teams surfaces real teams and excludes the device itself", async () => {
		const h = makeHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "list_teams" }));
		expect(reply.ok).toBe(true);
		const teams = (reply.result as { teams: { team: string }[] }).teams.map((t) => t.team);
		// team-a and team-b are surfaced; the device itself (pixel) stays excluded.
		expect(teams.sort()).toEqual(["team-a", "team-b"]);
	});

	it("rejects a conversationId held by a live real socket", async () => {
		const h = makeHarness();
		h.conversationRegistry.set("conv-stolen", realTeamWs("some-window", "w1"));
		const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-stolen"));
		expect(reply.ok).toBe(false);
	});

	it("an existing peer self-heals its conversation pointer", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		h.conversationRegistry.delete("conv-pixel");

		await h.handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const peer = h.registry.get("pixel")?.get("conv-pixel");
		expect(h.conversationRegistry.get("conv-pixel")).toBe(peer);
	});

	it("a register op renames the device, preserving the mailbox", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		h.mailboxStore.get(OWNER)?.append({ kind: "message", session_id: "s", body: "kept" });

		const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op2", "pixel-9", "conv-1"));
		expect(reply.ok).toBe(true);
		expect(h.registry.get("pixel")).toBeUndefined();
		expect(h.registry.get("pixel-9")?.get("conv-1")).toBeDefined();

		const poll = await h.handler.handleFrame(frame({ kind: "poll" }, "op3", "pixel-9", "conv-1"));
		expect((poll.result as { entries: { body?: string }[] }).entries[0].body).toBe("kept");
	});

	it("non-register ops still cannot gateway device names", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "op2", "tablet", "conv-1"));
		expect(reply.ok).toBe(false);
	});
});
