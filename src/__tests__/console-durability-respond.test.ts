import { describe, expect, it } from "vitest";
import { type ConsoleRoutes, createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { fakeDurable, frame, jsonRes, makeDeliverToOwner, OWNER } from "./helpers/console.js";

const stubDeliver = makeDeliverToOwner(new DeviceMailboxStore());

describe("createConsoleDispatcher", () => {
	describe("durable send/respond idempotency (restart-proof): respond", () => {
		it("a federated respond whose relay fails: a SAME-dispatcher retry re-executes instead of replaying the stale optimistic {delivered:true} reply", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			let respondCalls = 0;
			let settledCallback: ((ok: boolean) => void) | undefined;
			const routes: ConsoleRoutes = {
				deliverToOwner: stubDeliver,
				send: async () => jsonRes({ session_id: "s", status: "running" }),
				respond: (_req, _body, opts) => {
					respondCalls++;
					settledCallback = opts?.onFederatedSettled;
					return jsonRes({ delivered: true, federated: true });
				},
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			};
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure(OWNER).recordSession("s1");
			const f = frame(
				{ kind: "respond", session_id: "s1", response: "done" },
				"op-respond-federated-fail-same-proc",
			);
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore,
			});
			const reply1 = await h1.handleFrame(f);
			expect(reply1.ok).toBe(true);
			expect(respondCalls).toBe(1);
			settledCallback?.(false);
			expect(durableOpStore.get("conv-pixel", "respond:op-respond-federated-fail-same-proc")).toBeUndefined();

			// A retry of the same opId on the SAME dispatcher must re-execute - not replay the
			// opCache's still-cached optimistic {delivered:true} reply from before the relay's
			// eventual failure was known.
			const reply2 = await h1.handleFrame(f);
			expect(respondCalls).toBe(2);
			expect(reply2.ok).toBe(true);
		});

		it("a simple (non-federated) respond durably completes; a REAL restart (fresh DurableOpStore reading a fresh durable snapshot) replays it without re-calling routes.respond", async () => {
			const durable = fakeDurable();
			let respondCalls = 0;
			const routes: ConsoleRoutes = {
				deliverToOwner: stubDeliver,
				send: async () => jsonRes({ session_id: "s", status: "running" }),
				respond: () => {
					respondCalls++;
					return jsonRes({ delivered: true });
				},
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			};
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure(OWNER).recordSession("s1");
			const f = frame({ kind: "respond", session_id: "s1", response: "done" }, "op-respond-durable");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore: new DurableOpStore(durable),
			});
			const r1 = await h1.handleFrame(f);
			expect(r1.ok).toBe(true);
			expect(respondCalls).toBe(1);

			const mailboxStore2 = new DeviceMailboxStore();
			mailboxStore2.ensure(OWNER).recordSession("s1");
			const h2 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore: mailboxStore2,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore: new DurableOpStore(durable),
			});
			const r2 = await h2.handleFrame(f);
			expect(r2).toEqual(r1);
			expect(respondCalls).toBe(1);
		});

		it("a share-withdrawn ('unshared') respond drop is never durably marked complete with a false {delivered:true}", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			let respondCalls = 0;
			const routes: ConsoleRoutes = {
				deliverToOwner: stubDeliver,
				send: async () => jsonRes({ session_id: "s", status: "running" }),
				respond: () => {
					respondCalls++;
					return jsonRes({ delivered: false, dropped: "unshared" });
				},
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			};
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure(OWNER).recordSession("s1");
			const f = frame({ kind: "respond", session_id: "s1", response: "done" }, "op-respond-unshared");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore,
			});
			const reply = await h1.handleFrame(f);
			expect(reply.ok).toBe(true);
			expect(respondCalls).toBe(1);
			// The share was withdrawn and nothing was actually delivered - the durable store must
			// never record this as a completed success.
			expect(durableOpStore.get("conv-pixel", "respond:op-respond-unshared")).toBeUndefined();

			// A retry re-attempts (routes.respond is called again) rather than replaying a false
			// success for up to 14 days.
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
			await h2.handleFrame(f);
			expect(respondCalls).toBe(2);
		});

		it("a share-withdrawn ('unshared') respond drop: a SAME-dispatcher retry re-attempts instead of replaying the stale optimistic {delivered:true} reply", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			let respondCalls = 0;
			const routes: ConsoleRoutes = {
				deliverToOwner: stubDeliver,
				send: async () => jsonRes({ session_id: "s", status: "running" }),
				respond: () => {
					respondCalls++;
					return jsonRes({ delivered: false, dropped: "unshared" });
				},
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			};
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure(OWNER).recordSession("s1");
			const f = frame({ kind: "respond", session_id: "s1", response: "done" }, "op-respond-unshared-same-proc");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore,
			});
			const reply1 = await h1.handleFrame(f);
			expect(reply1.ok).toBe(true);
			expect(respondCalls).toBe(1);

			// A retry of the same opId on the SAME dispatcher (no restart, no fresh opCache) must
			// re-attempt - not replay the opCache's still-cached optimistic {delivered:true} reply
			// from before the drop was known, the way a fresh-dispatcher retry alone would mask.
			const reply2 = await h1.handleFrame(f);
			expect(respondCalls).toBe(2);
			expect(reply2.result).toEqual({ delivered: true });
		});

		it("a federated respond only durably completes when the relay-pin actually settles; a retry after settlement replays without re-calling routes.respond", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			let respondCalls = 0;
			let settledCallback: ((ok: boolean) => void) | undefined;
			const routes: ConsoleRoutes = {
				deliverToOwner: stubDeliver,
				send: async () => jsonRes({ session_id: "s", status: "running" }),
				respond: (_req, _body, opts) => {
					respondCalls++;
					settledCallback = opts?.onFederatedSettled;
					return jsonRes({ delivered: true, federated: true });
				},
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			};
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure(OWNER).recordSession("s1");
			const f = frame({ kind: "respond", session_id: "s1", response: "done" }, "op-respond-federated");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore,
			});
			const reply = await h1.handleFrame(f);
			expect(reply.ok).toBe(true);
			expect(respondCalls).toBe(1);
			// The relay has not settled yet - nothing durable to replay.
			expect(durableOpStore.get("conv-pixel", "respond:op-respond-federated")).toEqual({ state: "in-flight" });

			settledCallback?.(true);
			expect(durableOpStore.get("conv-pixel", "respond:op-respond-federated")).toEqual({
				state: "complete",
				result: { delivered: true },
			});

			// A retry after settlement replays the durable record's own reply rather than
			// re-invoking routes.respond.
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
			const r2 = await h2.handleFrame(f);
			expect(r2).toEqual(reply);
			expect(respondCalls).toBe(1);
		});

		it("a federated respond whose relay ultimately fails clears the durable record; a retry re-executes rather than replaying the failure", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			let respondCalls = 0;
			let settledCallback: ((ok: boolean) => void) | undefined;
			const routes: ConsoleRoutes = {
				deliverToOwner: stubDeliver,
				send: async () => jsonRes({ session_id: "s", status: "running" }),
				respond: (_req, _body, opts) => {
					respondCalls++;
					settledCallback = opts?.onFederatedSettled;
					return jsonRes({ delivered: true, federated: true });
				},
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			};
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure(OWNER).recordSession("s1");
			const f = frame({ kind: "respond", session_id: "s1", response: "done" }, "op-respond-federated-fail");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore,
			});
			await h1.handleFrame(f);
			expect(respondCalls).toBe(1);
			settledCallback?.(false);
			expect(durableOpStore.get("conv-pixel", "respond:op-respond-federated-fail")).toBeUndefined();

			// A retry re-executes (routes.respond is called again) instead of replaying the failure.
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
			await h2.handleFrame(f);
			expect(respondCalls).toBe(2);
		});

		it("a respond to an unknown session_id throws before dispatch; the generic failure reaction (not a case-specific handler) clears the durable record so a retry re-attempts", async () => {
			const durableOpStore = new DurableOpStore(fakeDurable());
			let respondCalls = 0;
			const routes: ConsoleRoutes = {
				deliverToOwner: stubDeliver,
				send: async () => jsonRes({ session_id: "s", status: "running" }),
				respond: () => {
					respondCalls++;
					return jsonRes({ delivered: true });
				},
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			};
			// No respondable session recorded for "s1" yet - canRespond() fails and the "respond"
			// case throws before ever calling routes.respond, so only handleFrame's generic
			// `.then`/`.catch` reaction (not a case-specific inline handler) ever clears this record.
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure(OWNER);
			const f = frame({ kind: "respond", session_id: "s1", response: "done" }, "op-respond-unknown-session");
			const h1 = createConsoleDispatcher({
				registry: new Map(),
				conversationRegistry: new Map(),
				mailboxStore,
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes,
				durableOpStore,
			});
			const r1 = await h1.handleFrame(f);
			expect(r1.ok).toBe(false);
			expect(respondCalls).toBe(0);
			expect(durableOpStore.get("conv-pixel", "respond:op-respond-unknown-session")).toBeUndefined();

			// Once the session becomes respondable, a retry of the same opId re-attempts rather
			// than replaying the stale failure - proving the generic reaction actually cleared it.
			mailboxStore.ensure(OWNER).recordSession("s1");
			const r2 = await h1.handleFrame(f);
			expect(r2.ok).toBe(true);
			expect(respondCalls).toBe(1);
		});
	});
});
