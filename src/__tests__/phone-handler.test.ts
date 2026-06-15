import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { createPhoneHandler, type PhoneRoutes } from "../arbiter/phone/phoneHandler.js";
import { PhonePeer } from "../arbiter/phone/phonePeer.js";
import type { ConversationRegistry, TeamRegistry, WsData } from "../arbiter/websocket.js";
import { DeviceMailbox, DeviceMailboxStore } from "../shared/device-mailbox.js";
import type { PhoneOp, PhoneRelayFrame } from "../shared/phone-protocol.js";

function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function frame(op: PhoneOp, opId = "op1", device = "pixel", conversationId = "conv-pixel"): PhoneRelayFrame {
	return { type: "phone_relay", v: 1, device, conversationId, opId, op };
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
	handler: ReturnType<typeof createPhoneHandler>;
}

function makeHarness(overrides: Partial<PhoneRoutes> = {}): Harness {
	const registry: TeamRegistry = new Map();
	const conversationRegistry: ConversationRegistry = new Map();
	const mailboxStore = new DeviceMailboxStore();
	const sendCalls: Record<string, unknown>[] = [];
	const respondCalls: Record<string, unknown>[] = [];

	const routes: PhoneRoutes = {
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
				{ team: "arbiter", status: "online", mode: "channel", queue_depth: 0 },
			]),
		// list_teams fans out via discover; mirror the team list here.
		discover: async () =>
			jsonRes([
				{ team: "team-a", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "pixel", status: "online", mode: "channel", queue_depth: 0 },
				{ team: "arbiter", status: "online", mode: "channel", queue_depth: 0 },
			]),
		...overrides,
	};

	const handler = createPhoneHandler({
		registry,
		conversationRegistry,
		mailboxStore,
		localHostId: "test-host",
		routes,
	});
	return { registry, conversationRegistry, mailboxStore, sendCalls, respondCalls, handler };
}

describe("PhonePeer", () => {
	it("channel_push lands as a message entry", () => {
		const box = new DeviceMailbox(1);
		const peer = new PhonePeer(() => box, "pixel", "conv-pixel", "conv-pixel");
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
		const peer = new PhonePeer(() => box, "pixel", "conv-pixel", "conv-pixel");
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
		const peer = new PhonePeer(() => box, "pixel", "conv-pixel", "conv-pixel");
		peer.send("not json");
		peer.send(JSON.stringify({ type: "evie_tools", tools: [] }));
		expect(box.size).toBe(0);
	});
});

describe("createPhoneHandler", () => {
	it("register inserts a virtual peer keyed by conversationId and returns the cursor", async () => {
		const h = makeHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "register" }));
		expect(reply.ok).toBe(true);
		// register hands back the connected Host id so the phone anchors its
		// composite (host, name) key and migrates bare-keyed threads onto it.
		expect(reply.result).toMatchObject({ device: "pixel", hostId: "test-host", cursor: 0 });
		expect((reply.result as { epoch: number }).epoch).toBeGreaterThan(0);

		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;
		expect(peer).toBeDefined();
		expect(peer.data.virtual).toBe(true);
		expect(peer.data.mode).toBe("channel");
		expect(h.conversationRegistry.get("conv-pixel")).toBe(peer);
	});

	it("rejects reserved device names", async () => {
		const h = makeHarness();
		for (const name of ["arbiter", "host"]) {
			const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op1", name, `conv-${name}`));
			expect(reply.ok).toBe(false);
			expect(reply.error).toContain("reserved");
			expect(h.registry.get(name)).toBeUndefined();
		}
	});

	it("rejects a device name that matches a devcontainer project, even a sleeping one", async () => {
		// Without this, a phone named after a sleeping catalog project squats its
		// registry slot: teams() shows it online, sends land in the phone mailbox,
		// and the real project's wake is suppressed.
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const mailboxStore = new DeviceMailboxStore();
		const handler = createPhoneHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localHostId: "test-host",
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

	it("two devices with the same name get separate subs and mailboxes", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		await h.handler.handleFrame(frame({ kind: "register" }, "op2", "pixel", "conv-2"));

		const subs = h.registry.get("pixel");
		expect(subs?.size).toBe(2);
		expect(h.mailboxStore.get("conv-1")).toBeDefined();
		expect(h.mailboxStore.get("conv-2")).toBeDefined();
		expect(h.mailboxStore.get("conv-1")).not.toBe(h.mailboxStore.get("conv-2"));
	});

	it("list_teams surfaces the host-agent, excludes the device and the cli host daemon", async () => {
		const h = makeHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "list_teams" }));
		expect(reply.ok).toBe(true);
		const teams = (reply.result as { teams: { team: string }[] }).teams.map((t) => t.team);
		// "arbiter" (the host-agent) is now surfaced; the cli "host" daemon and the
		// device itself stay excluded.
		expect(teams.sort()).toEqual(["arbiter", "team-a"]);
	});

	it("send forwards from/fromConversationId/to and returns the session", async () => {
		const h = makeHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "send", to: "team-a", body: "hello" }, "op2"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ session_id: "conv:host:team-a", status: "running" });
		expect(h.sendCalls[0]).toMatchObject({
			from: "pixel",
			fromConversationId: "conv-pixel",
			to: "team-a",
			body: "hello",
			// Phone sends must never enter the route's CLI branch (random session ids).
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

		// Simulate routes.send broadcasting a channel_push to the phone as target.
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
		h.mailboxStore.get("conv-pixel")?.append({
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

	it("removePeer tears down only this install", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		await h.handler.handleFrame(frame({ kind: "register" }, "op2", "pixel", "conv-2"));

		h.handler.removePeer("conv-1");
		expect(h.registry.get("pixel")?.size).toBe(1);
		expect(h.conversationRegistry.get("conv-1")).toBeUndefined();
		expect(h.mailboxStore.get("conv-1")).toBeUndefined();
		expect(h.mailboxStore.get("conv-2")).toBeDefined();

		h.handler.removePeer("conv-2");
		expect(h.registry.get("pixel")).toBeUndefined();
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
		const handler = createPhoneHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localHostId: "test-host",
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
		expect(reply.result).toEqual({ session_id: "conv:conv-pixel:test-host/asleep-team", status: "running" });
	});

	it("TTL sweep evicts the peer together with its mailbox", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));

		const box = h.mailboxStore.get("conv-pixel");
		if (box) box.lastActivity = Date.now() - 7_200_000;
		h.mailboxStore.sweepExpired();

		expect(h.mailboxStore.get("conv-pixel")).toBeUndefined();
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
		h.mailboxStore.delete("conv-pixel");
		peer.send(JSON.stringify({ type: "response_push", session_id: "s", response: "after-sweep" }));

		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const result = reply.result as { entries: { body?: string }[] };
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].body).toBe("after-sweep");
	});

	it("a register op renames the device, preserving the mailbox", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }, "op1", "pixel", "conv-1"));
		h.mailboxStore.get("conv-1")?.append({ kind: "message", session_id: "s", body: "kept" });

		const reply = await h.handler.handleFrame(frame({ kind: "register" }, "op2", "pixel-9", "conv-1"));
		expect(reply.ok).toBe(true);
		expect(h.registry.get("pixel")).toBeUndefined();
		expect(h.registry.get("pixel-9")?.get("conv-1")).toBeDefined();

		const poll = await h.handler.handleFrame(frame({ kind: "poll" }, "op3", "pixel-9", "conv-1"));
		expect((poll.result as { entries: { body?: string }[] }).entries[0].body).toBe("kept");
	});

	it("non-register ops still cannot switch device names", async () => {
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
		const handler = createPhoneHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localHostId: "test-host",
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
		expect(reply.result).toEqual({ session_id: "conv:conv-pixel:test-host/asleep", status: "running" });

		resolveSend?.(jsonRes({ error: 'Team "asleep" is not connected' }, 404));
		await new Promise((r) => setTimeout(r, 10));

		const poll = await handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const entries = (poll.result as { entries: { status?: string; body?: string; session_id: string }[] }).entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			status: "error",
			session_id: "conv:conv-pixel:test-host/asleep",
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
		const handler = createPhoneHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localHostId: "test-host",
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
		expect(reply.result).toEqual({ session_id: "conv:conv-pixel:test-host/sleepy-cli", status: "running" });

		resolveSend?.(
			jsonRes(
				{ error: '"sleepy-cli" is a CLI-mode agent; phone chat supports channel-mode (Claude) teams only' },
				409,
			),
		);
		await new Promise((r) => setTimeout(r, 10));

		const poll = await handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const entries = (poll.result as { entries: { body?: string; status?: string; session_id: string }[] }).entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ session_id: "conv:conv-pixel:test-host/sleepy-cli", status: "error" });
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
		expect(h.sendCalls).toHaveLength(2);
		expect(h.sendCalls[0]).toMatchObject({ fromConversationId: "conv-a", body: "A" });
		expect(h.sendCalls[1]).toMatchObject({ fromConversationId: "conv-b", body: "B" });
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
		const handler = createPhoneHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			localHostId: "test-host",
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
		const box = h.mailboxStore.get("conv-pixel");
		if (box) box.lastActivity = Date.now() - 7_200_000;
		h.mailboxStore.sweepExpired();

		const peer2 = h.handler.ensurePeer("pixel", "conv-pixel");
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
		// Epochs are random (the phone compares them only for equality), so the
		// contract is "different", not "greater" - greater was the old counter
		// semantics that collided across arbiter restarts.
		const store = new DeviceMailboxStore();
		const e1 = store.ensure("x").epoch;
		store.delete("x");
		const e2 = store.ensure("x").epoch;
		expect(e2).not.toBe(e1);
	});
});
