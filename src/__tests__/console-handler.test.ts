import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { type ConsoleRoutes, createConsoleHandler } from "../gateway/console/consoleHandler.js";
import { ConsolePeer } from "../gateway/console/consolePeer.js";
import type { ConversationRegistry, TeamRegistry, WsData } from "../gateway/websocket.js";
import type { ConsoleOp, OpenedConsoleFrame } from "../shared/console-protocol.js";
import { DeviceMailbox, DeviceMailboxStore } from "../shared/device-mailbox.js";
import { ownerKeyId } from "../shared/owner-id.js";

function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The default owner for test frames. The mailbox is keyed by this (via ownerKeyId),
// so every default frame shares one owner inbox; pass a different ownerSignPub to
// simulate a second owner.
const OWNER_PUB = "owner-pub";
const OWNER = ownerKeyId(OWNER_PUB);

// The handler operates on an OPENED frame (the pump unseals the wire frame first),
// so tests construct that directly. A stable signer per conversation satisfies the
// install binding; tests that exercise the binding pass an explicit signer. All
// frames share one owner by default (the inbox is owner-keyed).
function frame(
	op: ConsoleOp,
	opId = "op1",
	device = "pixel",
	conversationId = "conv-pixel",
	signerSignPub = `signer-${conversationId}`,
	ownerSignPub = OWNER_PUB,
): OpenedConsoleFrame {
	return { opId, signerSignPub, ownerSignPub, conversationId, device, op };
}

/** A minimal non-virtual socket standing in for a real devcontainer connection. */
function realTeamWs(team: string, subId: string): ServerWebSocket<WsData> {
	return {
		readyState: 1,
		send: () => {},
		close: () => {},
		ping: () => {},
		data: {
			teamName: team,
			subId,
			conversationId: null,
			mode: "channel",
			missedPings: 0,
			isStale: false,
			handshakeConfirmed: true,
		},
	} as unknown as ServerWebSocket<WsData>;
}

interface Harness {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	mailboxStore: DeviceMailboxStore;
	sendCalls: Record<string, unknown>[];
	respondCalls: Record<string, unknown>[];
	handler: ReturnType<typeof createConsoleHandler>;
}

function makeHarness(overrides: Partial<ConsoleRoutes> = {}): Harness {
	const registry: TeamRegistry = new Map();
	const conversationRegistry: ConversationRegistry = new Map();
	const mailboxStore = new DeviceMailboxStore();
	const sendCalls: Record<string, unknown>[] = [];
	const respondCalls: Record<string, unknown>[] = [];

	const routes: ConsoleRoutes = {
		send: async (_req, body) => {
			sendCalls.push(body);
			return jsonRes({ session_id: "conv:host:team-a", status: "running" });
		},
		respond: (_req, body) => {
			respondCalls.push(body);
			return jsonRes({ delivered: true });
		},
		teams: () =>
			jsonRes([
				{ team: "team-a", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "pixel", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "gateway", status: "online", mode: "channel", queue_depth: 0 },
			]),
		// list_teams fans out via discover; mirror the team list here.
		discover: async () =>
			jsonRes([
				{ team: "team-a", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "pixel", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "gateway", status: "online", mode: "channel", queue_depth: 0 },
			]),
		...overrides,
	};

	const handler = createConsoleHandler({
		registry,
		conversationRegistry,
		mailboxStore,
		localGatewayId: "test-host",
		routes,
	});
	return { registry, conversationRegistry, mailboxStore, sendCalls, respondCalls, handler };
}

describe("ConsolePeer", () => {
	it("channel_push lands as a message entry", () => {
		const box = new DeviceMailbox(1);
		const peer = new ConsolePeer(() => box, "pixel", "conv-pixel", "conv-pixel");
		peer.send(
			JSON.stringify({
				type: "channel_push",
				from: "team-a",
				request_type: "question",
				body: "need a hand",
				effort: "standard",
				session_id: "conv:team-a:pixel",
				is_follow_up: false,
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

describe("createConsoleHandler", () => {
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

	it("rejects reserved device names", async () => {
		const h = makeHarness();
		for (const name of ["gateway", "host"]) {
			const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op1", name, `conv-${name}`));
			expect(reply.ok).toBe(false);
			expect(reply.error).toContain("reserved");
			expect(h.registry.get(name)).toBeUndefined();
		}
	});

	it("rejects a device name that matches a devcontainer project, even a sleeping one", async () => {
		// Without this, a console named after a sleeping catalog project squats its
		// registry slot: teams() shows it online, sends land in the console mailbox,
		// and the real project's wake is suppressed.
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const mailboxStore = new DeviceMailboxStore();
		const handler = createConsoleHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
			isProjectName: (name) => name === "recipe-app",
		});

		const reply = await handler.handleFrame(frame({ kind: "register" }, "op1", "recipe-app", "conv-x"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("project on the bridge");
		expect(registry.get("recipe-app")).toBeUndefined();
	});

	it("rejects a device name already held by a real team", async () => {
		const h = makeHarness();
		const subs = new Map([["abc123", realTeamWs("team-a", "abc123")]]);
		h.registry.set("team-a", subs);

		const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op1", "team-a", "conv-x"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("existing team");
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

	it("list_teams surfaces the host-agent, excludes the device and the cli host daemon", async () => {
		const h = makeHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "list_teams" }));
		expect(reply.ok).toBe(true);
		const teams = (reply.result as { teams: { team: string }[] }).teams.map((t) => t.team);
		// "gateway" (the host-agent) is now surfaced; the cli "host" daemon and the
		// device itself stay excluded.
		expect(teams.sort()).toEqual(["gateway", "team-a"]);
	});

	it("send forwards from/fromConversationId/to and returns the session", async () => {
		const h = makeHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "send", to: "team-a", body: "hello" }, "op2"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ session_id: "conv:host:team-a", status: "running" });
		expect(h.sendCalls[0]).toMatchObject({
			from: "pixel",
			fromConversationId: OWNER,
			to: "team-a",
			body: "hello",
			// Console sends must never enter the route's CLI branch (random session ids).
			channelOnly: true,
		});
	});

	it("send surfaces a route error as ok:false", async () => {
		const h = makeHarness({ send: async () => jsonRes({ error: 'Team "team-a" is not connected' }, 404) });
		const reply = await h.handler.handleFrame(frame({ kind: "send", to: "team-a", body: "hi" }));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not connected");
	});

	it("send forwards op.files to routes.send", async () => {
		const h = makeHarness();
		const file = { filename: "shot.png", mime: "image/png", size: 3, descriptiveKey: "shot.png", base64: "aGk=" };
		await h.handler.handleFrame(frame({ kind: "send", to: "team-a", body: "see this", files: [file] }, "op2"));
		expect(h.sendCalls[0].files).toEqual([file]);
	});

	it("a retried send with the same opId runs the route once (idempotent)", async () => {
		const h = makeHarness();
		const file = { filename: "a.png", mime: "image/png", size: 3, descriptiveKey: "a.png", base64: "aGk=" };
		const f = frame({ kind: "send", to: "team-a", body: "x", files: [file] }, "dup-op");
		// Concurrent retry coalesces onto the in-flight promise; a later retry replays.
		const [r1, r2] = await Promise.all([h.handler.handleFrame(f), h.handler.handleFrame(f)]);
		const r3 = await h.handler.handleFrame(f);
		expect(h.sendCalls.length).toBe(1);
		expect(r1.result).toEqual(r2.result);
		expect(r3.result).toEqual(r1.result);
	});

	function deliverInbound(h: Harness, sessionId: string): void {
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;
		peer.send(
			JSON.stringify({
				type: "channel_push",
				from: "team-a",
				request_type: "question",
				body: "ping",
				effort: "standard",
				session_id: sessionId,
				is_follow_up: false,
			}),
		);
	}

	it("respond forwards a received thread to routes.respond", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		deliverInbound(h, "conv:team-a:pixel");

		const reply = await h.handler.handleFrame(
			frame({ kind: "respond", session_id: "conv:team-a:pixel", response: "ok" }, "op2"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ delivered: true });
		expect(h.respondCalls[0]).toMatchObject({ session_id: "conv:team-a:test-host/pixel", response: "ok" });
	});

	it("respond rejects a session never delivered to this device (and never reaches resolveHandshake)", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));

		// A handshake-style id, or any foreign conversation's session.
		for (const sid of ["hs-deadbeef", "conv:other-window:team-b"]) {
			const reply = await h.handler.handleFrame(frame({ kind: "respond", session_id: sid, response: "x" }, sid));
			expect(reply.ok).toBe(false);
			expect(reply.error).toContain("Unknown session_id");
		}
		expect(h.respondCalls).toHaveLength(0);
	});

	it("an agent message delivered to the peer is drained by poll", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));

		// Simulate routes.send broadcasting a channel_push to the console as target.
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;
		peer.send(
			JSON.stringify({
				type: "channel_push",
				from: "team-a",
				request_type: "question",
				body: "ping from agent",
				effort: "standard",
				session_id: "conv:team-a:pixel",
				is_follow_up: false,
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

	it("a notice session id is never respondable", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		// Notices are appended directly to the mailbox (broadcast route), never via
		// the peer push path, so they are not recorded as inbound sessions.
		h.mailboxStore.get(OWNER)?.append({
			kind: "notice",
			session_id: "notice:recipe-app",
			from: "recipe-app",
			title: "cycle done",
			body: "report",
		});
		const poll = await h.handler.handleFrame(frame({ kind: "poll" }, "p-notice"));
		expect((poll.result as { entries: { kind: string }[] }).entries[0].kind).toBe("notice");

		const reply = await h.handler.handleFrame(
			frame({ kind: "respond", session_id: "notice:recipe-app", response: "hi" }, "r-notice"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("Unknown session_id");
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

	it("rejects a conversationId held by a live real socket", async () => {
		const h = makeHarness();
		h.conversationRegistry.set("conv-stolen", realTeamWs("some-window", "w1"));
		const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-stolen"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("in use");
	});

	it("an existing peer self-heals its conversation pointer", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		h.conversationRegistry.delete("conv-pixel");

		await h.handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const peer = h.registry.get("pixel")?.get("conv-pixel");
		expect(h.conversationRegistry.get("conv-pixel")).toBe(peer);
	});

	it("rejects send to a CLI-mode team instead of losing the answer", async () => {
		const h = makeHarness();
		const cliWs = realTeamWs("cli-team", "c1");
		cliWs.data.mode = "cli";
		h.registry.set("cli-team", new Map([["c1", cliWs]]));

		const reply = await h.handler.handleFrame(frame({ kind: "send", to: "cli-team", body: "hi" }));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("CLI-mode");
		expect(h.sendCalls).toHaveLength(0);
	});

	it("a send blocked by a slow wake returns the deterministic session id", async () => {
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const mailboxStore = new DeviceMailboxStore();
		const handler = createConsoleHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			sendBoundMs: 50,
			routes: {
				send: () => new Promise<Response>(() => {}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});

		const reply = await handler.handleFrame(frame({ kind: "send", to: "asleep-team", body: "hi" }));
		expect(reply.ok).toBe(true);
		// The deterministic session id carries the canonical host-qualified target.
		expect(reply.result).toEqual({ session_id: `conv:${OWNER}:test-host/asleep-team`, status: "running" });
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
		expect(reply.error).toContain("register op to rename");
	});

	it("a backgrounded send failure surfaces as an error reply in the mailbox", async () => {
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const mailboxStore = new DeviceMailboxStore();
		let resolveSend: ((res: Response) => void) | undefined;
		const handler = createConsoleHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			sendBoundMs: 20,
			routes: {
				send: () =>
					new Promise<Response>((resolve) => {
						resolveSend = resolve;
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});

		const reply = await handler.handleFrame(frame({ kind: "send", to: "asleep", body: "hi" }));
		expect(reply.result).toEqual({ session_id: `conv:${OWNER}:test-host/asleep`, status: "running" });

		resolveSend?.(jsonRes({ error: 'Team "asleep" is not connected' }, 404));
		await new Promise((r) => setTimeout(r, 10));

		const poll = await handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const entries = (poll.result as { entries: { status?: string; body?: string; session_id: string }[] }).entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			status: "error",
			session_id: `conv:${OWNER}:test-host/asleep`,
		});
		expect(entries[0].body).toContain("not connected");
	});

	it("a sleeping CLI team woken past the bound lands a clean error, never a random session id", async () => {
		// The route's channelOnly check rejects the woken CLI team with 409 after
		// the relay bound already returned "running". The continuation must turn
		// that into an error reply on the deterministic session, not mirror a
		// random-uuid session into the mailbox.
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const mailboxStore = new DeviceMailboxStore();
		let resolveSend: ((res: Response) => void) | undefined;
		const handler = createConsoleHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			sendBoundMs: 20,
			routes: {
				send: () =>
					new Promise<Response>((resolve) => {
						resolveSend = resolve;
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});

		const reply = await handler.handleFrame(frame({ kind: "send", to: "sleepy-cli", body: "hi" }));
		expect(reply.result).toEqual({ session_id: `conv:${OWNER}:test-host/sleepy-cli`, status: "running" });

		resolveSend?.(
			jsonRes(
				{ error: '"sleepy-cli" is a CLI-mode agent; console chat supports channel-mode (Claude) teams only' },
				409,
			),
		);
		await new Promise((r) => setTimeout(r, 10));

		const poll = await handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const entries = (poll.result as { entries: { body?: string; status?: string; session_id: string }[] }).entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ session_id: `conv:${OWNER}:test-host/sleepy-cli`, status: "error" });
		expect(entries[0].body).toContain("CLI-mode");
	});

	it("a retried opId replays the cached reply without re-running the send", async () => {
		const h = makeHarness();
		const f = frame({ kind: "send", to: "team-a", body: "hi" }, "op-dup");
		const r1 = await h.handler.handleFrame(f);
		const r2 = await h.handler.handleFrame(f);
		expect(r1).toEqual(r2);
		expect(h.sendCalls).toHaveLength(1);
	});

	it("concurrent retries of one opId coalesce onto a single dispatch", async () => {
		const h = makeHarness();
		const f = frame({ kind: "send", to: "team-a", body: "hi" }, "op-coalesce");
		const [r1, r2] = await Promise.all([h.handler.handleFrame(f), h.handler.handleFrame(f)]);
		expect(r1).toEqual(r2);
		expect(h.sendCalls).toHaveLength(1);
	});

	it("the same opId on two conversations does not cross-replay", async () => {
		const h = makeHarness();
		const a = await h.handler.handleFrame(
			frame({ kind: "send", to: "team-a", body: "A" }, "op-x", "pixel", "conv-a"),
		);
		const b = await h.handler.handleFrame(
			frame({ kind: "send", to: "team-a", body: "B" }, "op-x", "tablet", "conv-b"),
		);
		expect(a.ok && b.ok).toBe(true);
		// opCache is per device-conversation, so the same opId on two installs does not
		// cross-replay even though both installs share the one owner inbox key.
		expect(h.sendCalls).toHaveLength(2);
		expect(h.sendCalls[0]).toMatchObject({ fromConversationId: OWNER, body: "A" });
		expect(h.sendCalls[1]).toMatchObject({ fromConversationId: OWNER, body: "B" });
	});

	it("a failed send is not cached; a retry re-runs once the target is back", async () => {
		let online = false;
		const h = makeHarness({
			send: async () =>
				online
					? jsonRes({ session_id: "conv:x:team-a", status: "running" })
					: jsonRes({ error: "not connected" }, 404),
		});
		const f = frame({ kind: "send", to: "team-a", body: "hi" }, "op-retry");
		const first = await h.handler.handleFrame(f);
		expect(first.ok).toBe(false);
		online = true;
		const second = await h.handler.handleFrame(f);
		expect(second.ok).toBe(true);
	});

	it("a backgrounded send reply survives a device rename", async () => {
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const mailboxStore = new DeviceMailboxStore();
		let resolveSend: ((res: Response) => void) | undefined;
		const handler = createConsoleHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			sendBoundMs: 20,
			routes: {
				send: () => new Promise<Response>((resolve) => (resolveSend = resolve)),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});

		await handler.handleFrame(frame({ kind: "send", to: "sleepy", body: "hi" }, "s1", "pixel", "C"));
		// Rename the same conversation before the send resolves.
		await handler.handleFrame(frame({ kind: "register" }, "r1", "pixel-9", "C"));
		resolveSend?.(jsonRes({ error: 'Team "sleepy" is not connected' }, 404));
		await new Promise((r) => setTimeout(r, 10));

		const poll = await handler.handleFrame(frame({ kind: "poll" }, "p1", "pixel-9", "C"));
		const entries = (poll.result as { entries: { body?: string; status?: string }[] }).entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ status: "error" });
		expect(entries[0].body).toContain("not connected");
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
		// contract is "different", not "greater" - greater was the old counter
		// semantics that collided across gateway restarts.
		const store = new DeviceMailboxStore();
		const e1 = store.ensure("x").epoch;
		store.delete("x");
		const e2 = store.ensure("x").epoch;
		expect(e2).not.toBe(e1);
	});
});

describe("console terminal ops (peek / tmux_send)", () => {
	function makeTerminalHarness() {
		const hostOps: Record<string, unknown>[] = [];
		const routes: ConsoleRoutes = {
			send: async () => jsonRes({ session_id: "s", status: "running" }),
			respond: () => jsonRes({ delivered: true }),
			teams: () => jsonRes([]),
			discover: async () => jsonRes([]),
		};
		const handler = createConsoleHandler({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			routes,
			isProjectName: (n) => n === "recipe-app",
			relayToHost: async (op) => {
				hostOps.push(op as unknown as Record<string, unknown>);
				if (op.kind === "peek") return { ok: true, result: { ansi: "SCREEN", hash: "h1" } };
				return { ok: true, result: { sent: true } };
			},
		});
		return { handler, hostOps };
	}

	it("peek resolves a devcontainer target and returns the captured pane + hash", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "recipe-app" }, "p1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ ansi: "SCREEN", hash: "h1" });
		expect(h.hostOps[0]).toEqual({ kind: "peek", target: { kind: "devcontainer", name: "recipe-app" } });
	});

	it("peek resolves the host-agent 'gateway' to its local tmux", async () => {
		const h = makeTerminalHarness();
		await h.handler.handleFrame(frame({ kind: "peek", target: "gateway" }, "p2"));
		expect(h.hostOps[0]).toMatchObject({ kind: "peek", target: { kind: "gateway", name: "gateway" } });
	});

	it("peek with a matching sinceHash returns unchanged and drops the body", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "recipe-app", sinceHash: "h1" }, "p3"));
		expect(reply.result).toEqual({ hash: "h1", unchanged: true });
	});

	it("rejects a loose session name (only host-agent + devcontainers are terminal-eligible)", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "some-loose" }, "p4"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not available");
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects a cross-Gateway target", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "other-gw/recipe-app" }, "p5"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("another Gateway");
		expect(h.hostOps).toHaveLength(0);
	});

	it("tmux_send with text relays sendText", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "tmux_send", target: "recipe-app", text: "/model opus" }, "s1"),
		);
		expect(reply.result).toEqual({ sent: true });
		// dedupKey = `${conversationId}:${opId}` so the host can replay a re-relayed send.
		expect(h.hostOps[0]).toEqual({
			kind: "sendText",
			target: { kind: "devcontainer", name: "recipe-app" },
			text: "/model opus",
			dedupKey: "conv-pixel:s1",
		});
	});

	it("tmux_send with a named key relays sendKey", async () => {
		const h = makeTerminalHarness();
		await h.handler.handleFrame(frame({ kind: "tmux_send", target: "gateway", key: "C-c" }, "s2"));
		expect(h.hostOps[0]).toEqual({
			kind: "sendKey",
			target: { kind: "gateway", name: "gateway" },
			key: "C-c",
			dedupKey: "conv-pixel:s2",
		});
	});

	it("a retried tmux_send with the same opId relays once (idempotent)", async () => {
		const h = makeTerminalHarness();
		const f = frame({ kind: "tmux_send", target: "recipe-app", key: "Enter" }, "dup");
		const [r1, r2] = await Promise.all([h.handler.handleFrame(f), h.handler.handleFrame(f)]);
		const r3 = await h.handler.handleFrame(f);
		expect(r1.ok && r2.ok && r3.ok).toBe(true);
		expect(h.hostOps).toHaveLength(1);
	});

	it("peek is a fresh read: a retried opId relays again (not idempotency-cached)", async () => {
		const h = makeTerminalHarness();
		const f = frame({ kind: "peek", target: "recipe-app" }, "samepeek");
		await h.handler.handleFrame(f);
		await h.handler.handleFrame(f);
		expect(h.hostOps).toHaveLength(2);
	});

	it("rejects a tmux_send with neither text nor key (no stray keystroke)", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "tmux_send", target: "recipe-app" }, "n1"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("exactly one");
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects a tmux_send with both text and key", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "tmux_send", target: "recipe-app", text: "x", key: "Enter" }, "b1"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("exactly one");
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects a key not on the whitelist at the gateway (fail fast, no host round-trip)", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "tmux_send", target: "recipe-app", key: "rm -rf" }, "k1"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("disallowed key");
		expect(h.hostOps).toHaveLength(0);
	});
});

describe("console cross-Domain handshake ops", () => {
	// A linked-but-offline peer: written into the peer set by a confirmed link, but its gateway is
	// not online and it has shared nothing back, so it never enters discovery. list_peers must still
	// report it (the roster read the post-link sharing flow depends on).
	const PEER_SET = [
		{ domainId: "bob", gatewayId: "bob-desktop" },
		{ domainId: "carol", gatewayId: "carol-laptop" },
	];
	function makeCrossDomainHarness() {
		const calls: Record<string, unknown[]> = {
			listen: [],
			request: [],
			confirm: [],
			cancel: [],
			listenState: [],
			listPeers: [],
		};
		const routes: ConsoleRoutes = {
			send: async () => jsonRes({ session_id: "s", status: "running" }),
			respond: () => jsonRes({ delivered: true }),
			teams: () => jsonRes([]),
			discover: async () => jsonRes([]),
		};
		const crossDomain = {
			listen: () => {
				calls.listen.push({});
				return {
					listeningToken: "test-host.tok",
					receiverOwnerSignPub: "recv-owner",
					receiverGatewaySignPub: "recv-gw-sign",
					receiverGatewayBoxPub: "recv-gw-box",
					receiverDomainId: "home",
					receiverGatewayId: "test-host",
					expiresAt: 123,
				};
			},
			request: async (args: Record<string, unknown>) => {
				calls.request.push(args);
				return {
					sas: "421717930842",
					requesterOwnerSignPub: args.requesterOwnerSignPub as string,
					receiverOwnerSignPub: "recv-owner",
					receiverDomainId: "bob",
					receiverGatewayId: "bob-desktop",
					receiverGatewaySignPub: "recv-gw-sign",
					receiverGatewayBoxPub: "recv-gw-box",
				};
			},
			confirm: (args: Record<string, unknown>) => {
				calls.confirm.push(args);
				return { ok: true };
			},
			cancel: (args: Record<string, unknown>) => {
				calls.cancel.push(args);
				return true;
			},
			listenState: (listeningToken: string) => {
				calls.listenState.push({ listeningToken });
				return {
					pairingArrived: true,
					pin: "thepin",
					sas: "421717930842",
					friendOwnerSignPub: "friend-owner",
					friendGatewaySignPub: "friend-gw-sign",
					friendGatewayBoxPub: "friend-gw-box",
					friendDomainId: "bob",
					friendGatewayId: "bob-desktop",
					expiresAt: 123,
				};
			},
			listPeers: () => {
				calls.listPeers.push({});
				return { peers: PEER_SET };
			},
		};
		const handler = createConsoleHandler({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			routes,
			crossDomain,
		});
		return { handler, calls };
	}

	const link = {
		link: {
			myOwnerSignPub: "mo",
			peerOwnerSignPub: "po",
			peerDomainId: "bob",
			peerGatewayId: "bob-desktop",
			peerSignPub: "ps",
			peerBoxPub: "pb",
			issuedAt: 1,
			nonce: "n",
		},
		ownerSignPub: "mo",
		signature: "sig",
	};

	it("cross_domain_listen returns the minted token + receiver keys", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_listen" }, "l1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toMatchObject({ listeningToken: "test-host.tok", receiverGatewayId: "test-host" });
		expect(h.calls.listen).toHaveLength(1);
	});

	it("cross_domain_request passes the VERIFIED owner key (the frame's), not the op's, to the coordinator", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(
			frame(
				{
					kind: "cross_domain_request",
					listeningToken: "bob-desktop.tok",
					pin: "thepin",
					// A console could LIE here; the gateway must ignore it and use the verified owner.
					requesterOwnerSignPub: "ATTACKER-CLAIMED-OWNER",
					requesterDomainId: "home",
					requesterGatewayId: "test-host",
				},
				"rq1",
			),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toMatchObject({ sas: "421717930842" });
		// The dispatch forwarded the FRAME's ownerSignPub (OWNER_PUB), never the op's claim.
		expect(h.calls.request[0]).toMatchObject({
			listeningToken: "bob-desktop.tok",
			pin: "thepin",
			requesterOwnerSignPub: OWNER_PUB,
			requesterDomainId: "home",
			requesterGatewayId: "test-host",
		});
	});

	it("cross_domain_confirm forwards only this owner's link side and returns ok (Model A)", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_confirm", pin: "thepin", mySignedLink: link }, "cf1"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ ok: true });
		expect(h.calls.confirm[0]).toEqual({ pin: "thepin", mySignedLink: link });
	});

	it("cross_domain_listen_state forwards the token and returns the receiver's pairing state", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_listen_state", listeningToken: "test-host.tok" }, "ls1"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toMatchObject({
			pairingArrived: true,
			sas: "421717930842",
			friendGatewayId: "bob-desktop",
		});
		expect(h.calls.listenState[0]).toEqual({ listeningToken: "test-host.tok" });
	});

	it("cross_domain_listen_state is a fresh read: a retried opId re-runs (never cached)", async () => {
		const h = makeCrossDomainHarness();
		const f = frame({ kind: "cross_domain_listen_state", listeningToken: "test-host.tok" }, "dup-ls");
		await h.handler.handleFrame(f);
		await h.handler.handleFrame(f);
		// The receiver polls this, so each call must hit the coordinator (not replay a cached reply).
		expect(h.calls.listenState).toHaveLength(2);
	});

	it("cross_domain_list_peers returns the peer set, listing a linked-but-offline peer", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_list_peers" }, "lp1"));
		expect(reply.ok).toBe(true);
		// The roster carries every linked peer projected to (domainId, gatewayId), regardless of
		// online / shared-back state, so the offline peer is present and PeerDetail is reachable.
		expect(reply.result).toEqual({
			peers: [
				{ domainId: "bob", gatewayId: "bob-desktop" },
				{ domainId: "carol", gatewayId: "carol-laptop" },
			],
		});
		expect(h.calls.listPeers).toHaveLength(1);
	});

	it("cross_domain_list_peers is a fresh read: a retried opId re-runs (never cached)", async () => {
		const h = makeCrossDomainHarness();
		const f = frame({ kind: "cross_domain_list_peers" }, "dup-lp");
		await h.handler.handleFrame(f);
		await h.handler.handleFrame(f);
		// A roster read must reflect live peer-set state, so each poll hits the coordinator.
		expect(h.calls.listPeers).toHaveLength(2);
	});

	it("a bare cross_domain_cancel stays a sweep-only no-op (no token/pin forwarded)", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_cancel" }, "cx1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ cancelled: true });
		expect(h.calls.cancel).toHaveLength(1);
		// Backward behavior: a bare cancel carries neither field, so the coordinator only sweeps.
		expect(h.calls.cancel[0]).toEqual({ listeningToken: undefined, pin: undefined });
	});

	it("cross_domain_cancel forwards the listening token + pin so the named window is invalidated", async () => {
		const h = makeCrossDomainHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_cancel", listeningToken: "test-host.tok", pin: "thepin" }, "cx2"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ cancelled: true });
		expect(h.calls.cancel).toHaveLength(1);
		// The token/pin reach the coordinator, which invalidates that window (so a subsequent
		// request to the token is rejected; see the coordinator's own cancel tests).
		expect(h.calls.cancel[0]).toEqual({ listeningToken: "test-host.tok", pin: "thepin" });
	});

	it("a retried cross_domain_confirm opId replays the cached reply without re-running", async () => {
		const h = makeCrossDomainHarness();
		const f = frame({ kind: "cross_domain_confirm", pin: "thepin", mySignedLink: link }, "dup-cf");
		const r1 = await h.handler.handleFrame(f);
		const r2 = await h.handler.handleFrame(f);
		expect(r1).toEqual(r2);
		// The coordinator's confirm ran ONCE (the opId cache absorbed the retry), so a
		// single-use pairing is never double-consumed by an honest retry.
		expect(h.calls.confirm).toHaveLength(1);
	});

	it("the cross_domain_* ops error cleanly when federation is not wired", async () => {
		const handler = createConsoleHandler({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});
		const reply = await handler.handleFrame(frame({ kind: "cross_domain_listen" }, "nf1"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not available");
	});
});

describe("console cross-Domain share ops", () => {
	// A team list mixing every kind, so the kind gate can be exercised: a devcontainer and a
	// loose session are shareable; the host-agent ("gateway"), a console-kind device, and an
	// unknown name are not. teams() carries each team's gatewayId (the canonical target's gw).
	function teamsList(): Response {
		return jsonRes([
			{ team: "app", gatewayId: "test-host", status: "online", kind: "devcontainer", queue_depth: 0 },
			{ team: "scratch-1", gatewayId: "test-host", status: "online", kind: "loose", queue_depth: 0 },
			{ team: "gateway", gatewayId: "test-host", status: "online", kind: "gateway", queue_depth: 0 },
			{ team: "pixel", gatewayId: "test-host", status: "online", kind: "console", queue_depth: 0 },
		]);
	}

	function makeShareHarness(opts: { linkedDomains?: string[] } = {}) {
		const linked = new Set(opts.linkedDomains ?? ["carol"]);
		const calls: Record<string, unknown[]> = { share: [], unshare: [], listShares: [], expireSessionJobs: [] };
		// An in-memory share set so the dispatch's effect is observable end to end.
		const set = new Set<string>();
		const key = (sessionTarget: string, domainId: string) => `${sessionTarget} ${domainId}`;
		const crossDomainShare = {
			share: (sessionTarget: string, domainId: string) => {
				calls.share.push({ sessionTarget, domainId });
				set.add(key(sessionTarget, domainId));
			},
			unshare: (sessionTarget: string, domainId: string): boolean => {
				calls.unshare.push({ sessionTarget, domainId });
				return set.delete(key(sessionTarget, domainId));
			},
			expireSessionJobs: (sessionTarget: string, domainId: string) => {
				calls.expireSessionJobs.push({ sessionTarget, domainId });
			},
			listShares: () => {
				calls.listShares.push({});
				return [...set].map((k) => {
					const [sessionTarget, domainId] = k.split(" ");
					return { sessionTarget, domainId };
				});
			},
			isLinkedDomain: (domainId: string) => linked.has(domainId),
		};
		const routes: ConsoleRoutes = {
			send: async () => jsonRes({ session_id: "s", status: "running" }),
			respond: () => jsonRes({ delivered: true }),
			teams: teamsList,
			discover: async () => teamsList(),
		};
		const handler = createConsoleHandler({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			routes,
			crossDomainShare,
		});
		return { handler, calls, set };
	}

	it("cross_domain_share marks a devcontainer session shared (hits the store)", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/app", domainId: "carol" }, "s1"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ ok: true });
		expect(h.calls.share).toEqual([{ sessionTarget: "test-host/app", domainId: "carol" }]);
	});

	it("cross_domain_share allows a loose session", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/scratch-1", domainId: "carol" }, "s2"),
		);
		expect(reply.ok).toBe(true);
		expect(h.calls.share).toHaveLength(1);
	});

	it("cross_domain_unshare withdraws a share AND expires its in-flight jobs (hits the store)", async () => {
		const h = makeShareHarness();
		await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/app", domainId: "carol" }, "s1"),
		);
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_unshare", sessionTarget: "test-host/app", domainId: "carol" }, "u1"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ ok: true });
		expect(h.calls.unshare).toEqual([{ sessionTarget: "test-host/app", domainId: "carol" }]);
		expect(h.set.size).toBe(0);
		// The un-share also settled any in-flight cross-Domain job for this (session, friend)
		// pair so an already-accepted send's reply stops at the destination, not just fresh sends.
		expect(h.calls.expireSessionJobs).toEqual([{ sessionTarget: "test-host/app", domainId: "carol" }]);
	});

	it("cross_domain_unshare on an absent share does NOT expire jobs (no-op stays cheap)", async () => {
		const h = makeShareHarness();
		// Nothing shared yet: the unshare removes nothing, so it must skip the job expiry.
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_unshare", sessionTarget: "test-host/app", domainId: "carol" }, "u1"),
		);
		expect(reply.ok).toBe(true);
		expect(h.calls.unshare).toHaveLength(1);
		expect(h.calls.expireSessionJobs).toHaveLength(0);
	});

	it("cross_domain_list_shares returns the current shares (hits the store)", async () => {
		const h = makeShareHarness();
		await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/app", domainId: "carol" }, "s1"),
		);
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_list_shares" }, "ls1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ shares: [{ sessionTarget: "test-host/app", domainId: "carol" }] });
		expect(h.calls.listShares).toHaveLength(1);
	});

	it("rejects sharing the host-agent (kind gateway) and never hits the store", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/gateway", domainId: "carol" }, "g1"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("only devcontainer and loose");
		expect(h.calls.share).toHaveLength(0);
	});

	it("rejects sharing a console-kind team", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/pixel", domainId: "carol" }, "c1"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("only devcontainer and loose");
		expect(h.calls.share).toHaveLength(0);
	});

	it("rejects sharing an unknown session", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/nope", domainId: "carol" }, "n1"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("only devcontainer and loose");
		expect(h.calls.share).toHaveLength(0);
	});

	it("rejects sharing a session on another Gateway (only local sessions)", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "other-gw/app", domainId: "carol" }, "x1"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("only local sessions");
		expect(h.calls.share).toHaveLength(0);
	});

	it("rejects sharing to an unlinked Domain and never hits the store", async () => {
		const h = makeShareHarness({ linkedDomains: ["carol"] });
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/app", domainId: "dave" }, "d1"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not a linked Domain");
		expect(h.calls.share).toHaveLength(0);
	});

	it("a retried cross_domain_share opId replays the cached ack without re-running", async () => {
		const h = makeShareHarness();
		const f = frame({ kind: "cross_domain_share", sessionTarget: "test-host/app", domainId: "carol" }, "dup-s");
		const r1 = await h.handler.handleFrame(f);
		const r2 = await h.handler.handleFrame(f);
		expect(r1).toEqual(r2);
		// The opId cache absorbed the retry, so the store saw exactly one share.
		expect(h.calls.share).toHaveLength(1);
	});

	it("a retried cross_domain_unshare opId replays the cached ack without re-running", async () => {
		const h = makeShareHarness();
		await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/app", domainId: "carol" }, "s1"),
		);
		const f = frame({ kind: "cross_domain_unshare", sessionTarget: "test-host/app", domainId: "carol" }, "dup-u");
		const r1 = await h.handler.handleFrame(f);
		const r2 = await h.handler.handleFrame(f);
		expect(r1).toEqual(r2);
		expect(h.calls.unshare).toHaveLength(1);
	});

	it("the share ops error cleanly when federation is not wired", async () => {
		const handler = createConsoleHandler({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});
		const reply = await handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "test-host/app", domainId: "carol" }, "nf-s"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not available");
		const lr = await handler.handleFrame(frame({ kind: "cross_domain_list_shares" }, "nf-ls"));
		expect(lr.ok).toBe(false);
		expect(lr.error).toContain("not available");
	});

	// Fix 5 regression: a BARE-name share must be stored under the CANONICAL gateway/name key,
	// the same form the relay gate / sweep / discovery compare against. The OLD code stored the
	// raw op.sessionTarget, so a bare-name share ("app") was filed as "app" and the relay's
	// "test-host/app" lookup never matched - the share silently never took effect (fail-closed).
	it("a bare-name share is stored under the canonical gateway/name key the relay looks up", async () => {
		const h = makeShareHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "app", domainId: "carol" }, "bare-s"),
		);
		expect(reply.ok).toBe(true);
		// The store was handed the CANONICAL "test-host/app", not the raw bare "app" - so the
		// relay gate, which looks up "test-host/app", will actually find it.
		expect(h.calls.share).toEqual([{ sessionTarget: "test-host/app", domainId: "carol" }]);
		// And the canonical form is what list_shares (the console's read) reports.
		const lr = await h.handler.handleFrame(frame({ kind: "cross_domain_list_shares" }, "bare-ls"));
		expect(lr.result).toEqual({ shares: [{ sessionTarget: "test-host/app", domainId: "carol" }] });
	});

	it("a bare-name unshare withdraws the canonical share it created", async () => {
		const h = makeShareHarness();
		await h.handler.handleFrame(
			frame({ kind: "cross_domain_share", sessionTarget: "app", domainId: "carol" }, "bare-s"),
		);
		const reply = await h.handler.handleFrame(
			frame({ kind: "cross_domain_unshare", sessionTarget: "app", domainId: "carol" }, "bare-u"),
		);
		expect(reply.ok).toBe(true);
		// The unshare canonicalizes too, so it keys identically to the share and removes it.
		expect(h.calls.unshare).toEqual([{ sessionTarget: "test-host/app", domainId: "carol" }]);
		expect(h.set.size).toBe(0);
	});
});

describe("console cross-Domain unlink op", () => {
	// The unlink dep fans out to the three local cleanup primitives (peers / shares / jobs)
	// and returns their counts. The harness stands in a fake that records the domainId it was
	// called with and returns canned counts, so the dispatch wiring is observable end to end.
	function makeUnlinkHarness(
		opts: { counts?: Record<string, { peers: number; shares: number; jobs: number }> } = {},
	) {
		const calls: string[] = [];
		const counts = opts.counts ?? { carol: { peers: 1, shares: 2, jobs: 3 } };
		const routes: ConsoleRoutes = {
			send: async () => jsonRes({ session_id: "s", status: "running" }),
			respond: () => jsonRes({ delivered: true }),
			teams: () => jsonRes([]),
			discover: async () => jsonRes([]),
		};
		const handler = createConsoleHandler({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			routes,
			// An unknown/already-unlinked Domain yields zero counts (the real primitives return 0).
			unlinkDomain: (domainId) => {
				calls.push(domainId);
				const c = counts[domainId] ?? { peers: 0, shares: 0, jobs: 0 };
				return { peersRemoved: c.peers, sharesDropped: c.shares, jobsExpired: c.jobs };
			},
		});
		return { handler, calls };
	}

	it("cross_domain_unlink runs the local cleanup and returns the counts", async () => {
		const h = makeUnlinkHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_unlink", domainId: "carol" }, "ul1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ peersRemoved: 1, sharesDropped: 2, jobsExpired: 3 });
		expect(h.calls).toEqual(["carol"]);
	});

	it("unlinking an unknown/already-unlinked Domain is a clean zero-count success", async () => {
		const h = makeUnlinkHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "cross_domain_unlink", domainId: "ghost" }, "ul2"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ peersRemoved: 0, sharesDropped: 0, jobsExpired: 0 });
		expect(h.calls).toEqual(["ghost"]);
	});

	it("a retried cross_domain_unlink opId replays the cached counts without re-running", async () => {
		const h = makeUnlinkHarness();
		const f = frame({ kind: "cross_domain_unlink", domainId: "carol" }, "dup-ul");
		const r1 = await h.handler.handleFrame(f);
		const r2 = await h.handler.handleFrame(f);
		expect(r1).toEqual(r2);
		// The opId cache absorbed the retry, so the cleanup ran exactly once - the second call
		// replays the first non-zero counts rather than re-running and reporting zero.
		expect(h.calls).toEqual(["carol"]);
	});

	it("cross_domain_unlink errors cleanly when federation is not wired", async () => {
		const handler = createConsoleHandler({
			registry: new Map(),
			conversationRegistry: new Map(),
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});
		const reply = await handler.handleFrame(frame({ kind: "cross_domain_unlink", domainId: "carol" }, "nf-ul"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not available");
	});
});
