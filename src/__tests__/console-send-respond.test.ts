import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import type { ConversationRegistry, TeamRegistry, WsData } from "../gateway/websocket.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { frame, type Harness, jsonRes, makeHarness, OWNER } from "./helpers/console.js";

describe("createConsoleDispatcher: send + respond", () => {
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
	});

	it("send forwards op.files to routes.send", async () => {
		const h = makeHarness();
		const file = {
			filename: "shot.png",
			mime: "image/png",
			size: 3,
			descriptiveKey: "shot.png",
			role: "attachment" as const,
			blobId: `sha256-${"a".repeat(64)}`,
		};
		await h.handler.handleFrame(frame({ kind: "send", to: "team-a", body: "see this", files: [file] }, "op2"));
		expect(h.sendCalls[0].files).toEqual([file]);
	});

	it("a retried send with the same opId runs the route once (idempotent)", async () => {
		const h = makeHarness();
		const file = {
			filename: "a.png",
			mime: "image/png",
			size: 3,
			descriptiveKey: "a.png",
			role: "attachment" as const,
			blobId: `sha256-${"b".repeat(64)}`,
		};
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
				body: "ping",
				session_id: sessionId,
			}),
		);
	}

	it("fans a delivered message and reply out to sibling Gateways, so a conversation held here reaches the polled one", async () => {
		// The console seals a same-Domain send directly to the target's Gateway, then only ever polls
		// its route Gateway - without the fan-out, the reply sits in a mailbox nothing reads.
		const fanned: { entry: Record<string, unknown>; dedupeKey: string }[] = [];
		const h = makeHarness({
			fanOutConsolePush: async (entry, dedupeKey) => {
				fanned.push({ entry: entry as Record<string, unknown>, dedupeKey });
			},
		});
		await h.handler.handleFrame(frame({ kind: "register" }));
		const sid = "conv.team-a.test-domain.test-host.pixel.dev";
		deliverInbound(h, sid);
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;
		peer.send(JSON.stringify({ type: "response_push", session_id: sid, response: "done", status: "completed" }));

		expect(fanned.map((f) => f.entry.kind)).toEqual(["message", "reply"]);
		expect(fanned[1].entry).toMatchObject({ session_id: sid, body: "done" });
		// A fresh key per append: relayWithRetry reuses it, a new append never collides with it.
		expect(new Set(fanned.map((f) => f.dedupeKey)).size).toBe(2);
	});

	it("respond forwards a received thread to routes.respond", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		// The session id is the opaque, fully-qualified store key the console echoes.
		const sid = "conv.team-a.test-domain.test-host.pixel.dev";
		deliverInbound(h, sid);

		const reply = await h.handler.handleFrame(frame({ kind: "respond", session_id: sid, response: "ok" }, "op2"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ delivered: true });
		// The store key reaches routes.respond verbatim - no bare->qualified normalization
		// under the fully-qualified grammar.
		expect(h.respondCalls[0]).toMatchObject({ session_id: sid, response: "ok" });
	});

	it("respond rejects a session never delivered to this device (and never reaches resolveHandshake)", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));

		// A handshake-style id, or any foreign conversation's session.
		for (const sid of ["hs-deadbeef", "conv:other-window:team-b"]) {
			const reply = await h.handler.handleFrame(frame({ kind: "respond", session_id: sid, response: "x" }, sid));
			expect(reply.ok).toBe(false);
		}
		expect(h.respondCalls).toHaveLength(0);
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
	});

	it("a send blocked by a slow wake returns the deterministic session id", async () => {
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const mailboxStore = new DeviceMailboxStore();
		const handler = createConsoleDispatcher({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			sendBoundMs: 50,
			routes: {
				send: () => new Promise<Response>(() => {}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			},
		});

		const reply = await handler.handleFrame(frame({ kind: "send", to: "asleep-team.dev", body: "hi" }));
		expect(reply.ok).toBe(true);
		// The deterministic session id is the canonical, fully-qualified store key.
		expect(reply.result).toEqual({
			session_id: `conv.${OWNER}.test-domain.test-host.asleep-team.dev`,
			status: "running",
		});
	});

	it("a backgrounded send failure surfaces as an error reply in the mailbox", async () => {
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const mailboxStore = new DeviceMailboxStore();
		let resolveSend: ((res: Response) => void) | undefined;
		const handler = createConsoleDispatcher({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			sendBoundMs: 20,
			routes: {
				send: () =>
					new Promise<Response>((resolve) => {
						resolveSend = resolve;
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			},
		});

		const reply = await handler.handleFrame(frame({ kind: "send", to: "asleep.dev", body: "hi" }));
		expect(reply.result).toEqual({
			session_id: `conv.${OWNER}.test-domain.test-host.asleep.dev`,
			status: "running",
		});

		resolveSend?.(jsonRes({ error: 'Team "asleep" is not connected' }, 404));
		await new Promise((r) => setTimeout(r, 10));

		const poll = await handler.handleFrame(frame({ kind: "poll" }, "op2"));
		const entries = (poll.result as { entries: { status?: string; body?: string; session_id: string }[] }).entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			status: "error",
			session_id: `conv.${OWNER}.test-domain.test-host.asleep.dev`,
		});
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
		const handler = createConsoleDispatcher({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			sendBoundMs: 20,
			routes: {
				send: () =>
					new Promise<Response>((resolve) => {
						resolveSend = resolve;
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			},
		});

		const reply = await handler.handleFrame(frame({ kind: "send", to: "sleepy-cli.dev", body: "hi" }));
		expect(reply.result).toEqual({
			session_id: `conv.${OWNER}.test-domain.test-host.sleepy-cli.dev`,
			status: "running",
		});

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
		expect(entries[0]).toMatchObject({
			session_id: `conv.${OWNER}.test-domain.test-host.sleepy-cli.dev`,
			status: "error",
		});
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
		const handler = createConsoleDispatcher({
			registry,
			conversationRegistry,
			mailboxStore,
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			sendBoundMs: 20,
			routes: {
				send: () => new Promise<Response>((resolve) => (resolveSend = resolve)),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
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
	});
});
