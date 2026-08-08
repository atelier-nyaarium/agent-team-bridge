import { describe, expect, it } from "vitest";
import { type ConsoleRoutes, createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { fakeDurable, frame, jsonRes, OWNER } from "./helpers/console.js";

describe("createConsoleDispatcher", () => {
	describe("durable send/respond idempotency (restart-proof): send", () => {
		it("a fast send durably completes; a REAL restart (fresh DurableOpStore reading a fresh durable snapshot, plus a fresh dispatcher) replays it without re-calling routes.send", async () => {
			const durable = fakeDurable();
			let sendCalls = 0;
			const routes: ConsoleRoutes = {
				send: async () => {
					sendCalls++;
					return jsonRes({ session_id: "conv:host:team-a", status: "running" });
				},
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			};
			const f = frame({ kind: "send", to: "team-a", body: "hi" }, "op-durable-fast");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore: new DurableOpStore(durable),
			});
			const r1 = await h1.handleFrame(f);
			expect(r1.ok).toBe(true);
			expect(sendCalls).toBe(1);

			// A restart reconstructs BOTH the dispatcher (cold op-cache) AND the DurableOpStore
			// (restore()-from-snapshot) over the same durable file - not just the dispatcher.
			const h2 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore: new DurableOpStore(durable),
			});
			const r2 = await h2.handleFrame(f);
			expect(r2).toEqual(r1);
			expect(sendCalls).toBe(1);
		});

		it("a backgrounded send stays in-flight until the background push actually lands, not when the running reply goes out", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			// One resolver per dispatch (not a single shared variable a retry would silently
			// reassign), so the ORIGINAL attempt's promise can be resolved independently of the
			// retry's.
			const resolvers: Array<(res: Response) => void> = [];
			let sendCalls = 0;
			const routes: ConsoleRoutes = {
				send: () =>
					new Promise<Response>((resolve) => {
						sendCalls++;
						resolvers.push(resolve);
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			};
			const f = frame({ kind: "send", to: "team-a", body: "hi" }, "op-durable-bg");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			const reply = await h1.handleFrame(f);
			expect(reply.result).toMatchObject({ status: "running" });
			expect(sendCalls).toBe(1);

			// A same-opId retry arriving NOW (a lost "running" reply, or a restart before the
			// background push lands) must RE-EXECUTE, not replay - the durable record is still
			// in-flight, since the "running" reply is not the real settlement.
			const h2 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			// This second dispatch's own send() call will hang forever (its own resolver is never
			// invoked in this test) - only assert it actually re-ran, not its own eventual reply.
			void h2.handleFrame(f);
			await new Promise((r) => setTimeout(r, 10));
			expect(sendCalls).toBe(2);

			// Now the ORIGINAL (h1) background push lands - the true settle point for the FIRST
			// attempt; h2's retry promise is deliberately left unresolved.
			resolvers[0]?.(jsonRes({ session_id: "conv:host:team-a", status: "sent" }));
			await new Promise((r) => setTimeout(r, 10));

			// A THIRD dispatch after the real settlement replays the stored result instead of
			// dispatching a third send.
			const h3 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			const r3 = await h3.handleFrame(f);
			expect(r3.ok).toBe(true);
			expect(sendCalls).toBe(2);
		});

		it("a losing concurrent attempt's failure never erases a winning attempt's already-durable completion (the CAS guard, exercised end to end)", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			const resolvers: Array<(res: Response) => void> = [];
			let sendCalls = 0;
			const routes: ConsoleRoutes = {
				send: () =>
					new Promise<Response>((resolve) => {
						sendCalls++;
						resolvers.push(resolve);
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			};
			const f = frame({ kind: "send", to: "team-a", body: "hi" }, "op-durable-race");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			await h1.handleFrame(f);
			expect(sendCalls).toBe(1);

			// A same-opId retry on a fresh dispatcher (cold opCache) re-executes concurrently with
			// h1's still-running attempt - the accepted eviction/re-execution tail.
			const h2 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			void h2.handleFrame(f);
			await new Promise((r) => setTimeout(r, 10));
			expect(sendCalls).toBe(2);

			// The ORIGINAL (h1) attempt settles successfully first.
			resolvers[0]?.(jsonRes({ session_id: "conv:host:team-a", status: "sent" }));
			await new Promise((r) => setTimeout(r, 10));
			const won = durableOpStore.get("conv-pixel", "send:op-durable-race");
			expect(won).toMatchObject({ state: "complete", result: { status: "sent" } });

			// The LOSING (h2) retry settles as a failure strictly AFTER the winner already completed.
			resolvers[1]?.(jsonRes({ error: "not connected" }, 404));
			await new Promise((r) => setTimeout(r, 10));

			// The already-won completion must survive unchanged - a losing attempt's clear() must
			// never erase it.
			expect(durableOpStore.get("conv-pixel", "send:op-durable-race")).toEqual(won);
		});

		it("two overlapping attempts that BOTH genuinely succeed: the first to settle wins permanently, the second's own success is discarded", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			const resolvers: Array<(res: Response) => void> = [];
			let sendCalls = 0;
			const routes: ConsoleRoutes = {
				send: () =>
					new Promise<Response>((resolve) => {
						sendCalls++;
						resolvers.push(resolve);
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			};
			const f = frame({ kind: "send", to: "team-a", body: "hi" }, "op-durable-success-race");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			await h1.handleFrame(f);
			expect(sendCalls).toBe(1);

			const h2 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			void h2.handleFrame(f);
			await new Promise((r) => setTimeout(r, 10));
			expect(sendCalls).toBe(2);

			// The ORIGINAL (h1) attempt settles successfully first.
			resolvers[0]?.(jsonRes({ session_id: "conv:host:team-a", status: "sent" }));
			await new Promise((r) => setTimeout(r, 10));
			const won = durableOpStore.get("conv-pixel", "send:op-durable-success-race");
			expect(won).toMatchObject({ state: "complete", result: { status: "sent" } });

			// The RETRY (h2) attempt ALSO genuinely succeeds, strictly after the winner already
			// completed - its own real success must not overwrite the first (write-once).
			resolvers[1]?.(jsonRes({ session_id: "conv:host:team-a", status: "sent" }));
			await new Promise((r) => setTimeout(r, 10));
			expect(durableOpStore.get("conv-pixel", "send:op-durable-success-race")).toEqual(won);
		});

		it("an eviction/teardown mid-flight followed by the ORIGINAL attempt's later failure never erases the RETRY attempt's still-live cache entry (no spurious third dispatch)", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			const resolvers: Array<(res: Response) => void> = [];
			let sendCalls = 0;
			const routes: ConsoleRoutes = {
				send: () =>
					new Promise<Response>((resolve) => {
						sendCalls++;
						resolvers.push(resolve);
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			};
			const f = frame({ kind: "send", to: "team-a", body: "hi" }, "op-durable-eviction-race");
			const h = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});

			// Attempt 1: backgrounds.
			await h.handleFrame(f);
			expect(sendCalls).toBe(1);

			// The plan's own accepted "capFifo eviction / device teardown during a live backgrounded
			// send" corner: the in-memory opCache entry for this conversation is dropped while
			// attempt 1 is still running. The durable record (a separate store) survives untouched.
			h.removePeer("conv-pixel");

			// Attempt 2: a same-opId retry misses the now-cold opCache, sees the durable record
			// still in-flight, and re-executes - the accepted corner itself, unchanged.
			void h.handleFrame(f);
			await new Promise((r) => setTimeout(r, 10));
			expect(sendCalls).toBe(2);

			// Attempt 1 (now stale, superseded by attempt 2) finally settles as a FAILURE.
			resolvers[0]?.(jsonRes({ error: "not connected" }, 404));
			await new Promise((r) => setTimeout(r, 10));

			// A third same-opId dispatch, while attempt 2 is STILL genuinely pending, must coalesce
			// onto attempt 2's own still-live cache entry - not launch a spurious third real dispatch.
			void h.handleFrame(f);
			await new Promise((r) => setTimeout(r, 10));
			expect(sendCalls).toBe(2);
		});

		it("a backgrounded send that ultimately FAILS clears the durable record; a later retry re-executes, not replays the failure", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			let resolveSend: ((res: Response) => void) | undefined;
			let sendCalls = 0;
			const routes: ConsoleRoutes = {
				send: () =>
					new Promise<Response>((resolve) => {
						sendCalls++;
						resolveSend = resolve;
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			};
			const f = frame({ kind: "send", to: "asleep.dev", body: "hi" }, "op-durable-bg-fail");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			await h1.handleFrame(f);
			resolveSend?.(jsonRes({ error: "not connected" }, 404));
			await new Promise((r) => setTimeout(r, 10));

			// A fresh handler retrying the same opId re-executes (the failure was never durably
			// stored as "complete") rather than replaying the stale error.
			const h2 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			void h2.handleFrame(f);
			await new Promise((r) => setTimeout(r, 10));
			expect(sendCalls).toBe(2);
		});

		it("a backgrounded send that ultimately FAILS: a SAME-dispatcher retry re-executes instead of replaying the stale optimistic 'running' reply", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			let resolveSend: ((res: Response) => void) | undefined;
			let sendCalls = 0;
			const routes: ConsoleRoutes = {
				send: () =>
					new Promise<Response>((resolve) => {
						sendCalls++;
						resolveSend = resolve;
					}),
				respond: () => jsonRes({ delivered: true }),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			};
			const f = frame({ kind: "send", to: "asleep.dev", body: "hi" }, "op-durable-bg-fail-same-proc");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				sendBoundMs: 20,
				routes,
				durableOpStore,
			});
			const reply1 = await h1.handleFrame(f);
			expect(reply1.result).toMatchObject({ status: "running" });
			resolveSend?.(jsonRes({ error: "not connected" }, 404));
			await new Promise((r) => setTimeout(r, 10));
			expect(durableOpStore.get("conv-pixel", "send:op-durable-bg-fail-same-proc")).toBeUndefined();

			// A retry of the same opId on the SAME dispatcher (no restart, no fresh opCache) must
			// re-execute - not replay the opCache's still-cached optimistic "running" reply from
			// before the failure was known.
			const reply2 = await h1.handleFrame(f);
			expect(sendCalls).toBe(2);
			expect(reply2.result).toMatchObject({ status: "running" });
		});

		it("a send and a respond sharing the SAME opId in one conversation never cross-replay each other's durable result", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			let sendCalls = 0;
			let respondCalls = 0;
			const routes: ConsoleRoutes = {
				send: async () => {
					sendCalls++;
					return jsonRes({ session_id: "s", status: "running" });
				},
				respond: () => {
					respondCalls++;
					return jsonRes({ delivered: true });
				},
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			};
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure(OWNER).recordSession("s1");
			const sendFrame = frame({ kind: "send", to: "team-a", body: "hi" }, "shared-op-id");
			const respondFrame = frame({ kind: "respond", session_id: "s1", response: "done" }, "shared-op-id");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore,
			});

			const sendReply = await h1.handleFrame(sendFrame);
			expect(sendReply.ok).toBe(true);
			expect(sendCalls).toBe(1);

			// The respond op reuses the identical opId - a FRESH dispatcher (cold opCache) so the
			// lookup actually reaches the durable layer, which is where a missing kind discriminator
			// would hit the send's own "complete" record and replay its result verbatim instead of
			// ever calling routes.respond.
			const mailboxStore2 = new DeviceMailboxStore();
			mailboxStore2.ensure(OWNER).recordSession("s1");
			const h2 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: mailboxStore2,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore,
			});
			const respondReply = await h2.handleFrame(respondFrame);
			expect(respondCalls).toBe(1);
			expect(respondReply.result).toEqual({ delivered: true });
		});
	});
});
