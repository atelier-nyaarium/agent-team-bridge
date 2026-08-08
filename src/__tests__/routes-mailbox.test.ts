import { describe, expect, it } from "vitest";
import { createRoutes, MAX_RESPONSE_FILE_BYTES } from "../gateway/routes.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { makeCtx, makeRegistry } from "./helpers/routes.js";

describe("routes", () => {
	describe("mirror taps (peer entries)", () => {
		function fakeChannelWs() {
			const pushed: Record<string, unknown>[] = [];
			return { readyState: 1, data: { mode: "channel" }, send: (data: string) => pushed.push(JSON.parse(data)) };
		}

		it("a local-to-local send mirrors both participants' own threads", async () => {
			const registry = makeRegistry({ "coolib.dev": fakeChannelWs() });
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ registry, mailboxStore, ownerId: () => "owner-1" });
			const { send } = createRoutes(ctx);

			await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "coolapp.dev",
				fromConversationId: "conv-1",
				to: "coolib.dev",
				body: "can you check this?",
				channelOnly: true,
			});

			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries).toHaveLength(2);
			expect(entries.every((e) => e.kind === "peer")).toBe(true);
			expect(entries.map((e) => e.session_id).sort()).toEqual(
				["conv.owner-1.alice.test-host.coolapp.dev", "conv.owner-1.alice.test-host.coolib.dev"].sort(),
			);
			for (const e of entries) {
				expect(e.from).toBe("alice.test-host.coolapp.dev");
				expect(e.to).toBe("alice.test-host.coolib.dev");
				expect(e.body).toBe("can you check this?");
			}
		});

		it("a console-originated send produces no peer mirror", async () => {
			const registry = makeRegistry({ "coolib.dev": fakeChannelWs() });
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure("owner-1");
			const ctx = makeCtx({ registry, mailboxStore, ownerId: () => "owner-1" });
			const { send } = createRoutes(ctx);

			await send(
				new Request("http://localhost/send", { method: "POST" }),
				{
					from: "Pixel 10 Pro XL",
					fromConversationId: "owner-1",
					to: "coolib.dev",
					body: "hey coolib",
					channelOnly: true,
				},
				{ consoleSender: true },
			);

			expect(mailboxStore.get("owner-1")!.drain().entries).toHaveLength(0);
		});

		it("a federated inbound send landing mirrors only the local target's own thread", async () => {
			const registry = makeRegistry({ "coolib.dev": fakeChannelWs() });
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ registry, mailboxStore, ownerId: () => "owner-1" });
			const { send } = createRoutes(ctx);

			await send(
				new Request("http://localhost/send", { method: "POST" }),
				{
					from: "alice.friend-gw.coolapp.dev",
					to: "coolib.dev",
					body: "cross-gateway hello",
					channelOnly: true,
					sessionId: "conv.friend-conv.alice.test-host.coolib.dev",
					returnRoute: {
						srcGateway: "friend-gw",
						srcConversationId: "friend-conv",
						srcSession: "conv.friend-conv.alice.test-host.coolib.dev",
					},
				},
				{ trustedInbound: true },
			);

			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				kind: "peer",
				session_id: "conv.owner-1.alice.test-host.coolib.dev",
				from: "alice.friend-gw.coolapp.dev",
				to: "alice.test-host.coolib.dev",
				body: "cross-gateway hello",
			});
		});

		it("a local-to-local reply mirrors both participants, with the replier as sender", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("conv.conv-1.alice.test-host.coolib.dev", "coolapp.dev", "coolib.dev", {
				persistent: true,
				fromConversationId: "conv-1",
			});
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ store, mailboxStore, ownerId: () => "owner-1" });
			const { respond } = createRoutes(ctx);

			respond(new Request("http://gateway/respond"), {
				session_id: "conv.conv-1.alice.test-host.coolib.dev",
				response: "looks good, shipping",
			});

			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries).toHaveLength(2);
			expect(entries.map((e) => e.session_id).sort()).toEqual(
				["conv.owner-1.alice.test-host.coolapp.dev", "conv.owner-1.alice.test-host.coolib.dev"].sort(),
			);
			for (const e of entries) {
				expect(e.from).toBe("alice.test-host.coolib.dev");
				expect(e.to).toBe("alice.test-host.coolapp.dev");
				expect(e.body).toBe("looks good, shipping");
			}
		});

		it("a console-originated reply produces no peer mirror", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("conv.conv-1.alice.test-host.coolib.dev", "coolapp.dev", "coolib.dev", {
				persistent: true,
				fromConversationId: "conv-1",
			});
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure("owner-1");
			const ctx = makeCtx({ store, mailboxStore, ownerId: () => "owner-1" });
			const { respond } = createRoutes(ctx);

			respond(
				new Request("http://gateway/respond"),
				{ session_id: "conv.conv-1.alice.test-host.coolib.dev", response: "on it" },
				{ consoleSender: true },
			);

			expect(mailboxStore.get("owner-1")!.drain().entries).toHaveLength(0);
		});

		it("respond() completing this gateway's own cross-Gateway origin anchor mirrors only the local asker, with the remote replier as sender", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			// Matches sendCrossGateway's own anchor shape: session_id embeds the REMOTE target's
			// address, and `to` is already the remote target's canonical form (qualifiedTo).
			store.create("conv.conv-1.alice.gw2.coolib.dev", "coolapp.dev", "alice.gw2.coolib.dev", {
				persistent: true,
				fromConversationId: "conv-1",
			});
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ store, mailboxStore, ownerId: () => "owner-1" });
			const { respond } = createRoutes(ctx);

			respond(
				new Request("http://gateway/respond"),
				{
					session_id: "conv.conv-1.alice.gw2.coolib.dev",
					response: "on it",
					title: "t",
					summary: "s",
					fullSpoken: "On it, spoken.",
				},
				// A remote-addressed anchor is only ever completed in-process by the sealed relay, which
				// marks itself trusted; an external HTTP caller is refused.
				{ trustedInbound: true },
			);

			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				kind: "peer",
				session_id: "conv.owner-1.alice.test-host.coolapp.dev",
				from: "alice.gw2.coolib.dev",
				to: "alice.test-host.coolapp.dev",
				body: "on it",
				title: "t",
				summary: "s",
				fullSpoken: "On it, spoken.",
			});
		});

		it("respond()'s returnRoute branch mirrors the local replier, with the remote asker as recipient", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			// Matches send()'s trustedInbound landing shape: from is already the remote asker's
			// canonical address, to is the local target's bare team name, and a returnRoute is set.
			store.create("conv.friend-conv.alice.test-host.coolib.dev", "alice.friend-gw.coolapp.dev", "coolib.dev", {
				persistent: true,
				returnRoute: {
					srcGateway: "friend-gw",
					srcConversationId: "friend-conv",
					srcSession: "conv.friend-conv.alice.test-host.coolib.dev",
				},
			});
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ store, mailboxStore, ownerId: () => "owner-1" });
			const { respond } = createRoutes(ctx);

			respond(new Request("http://gateway/respond"), {
				session_id: "conv.friend-conv.alice.test-host.coolib.dev",
				response: "sure thing",
				title: "t",
				summary: "s",
				fullSpoken: "Sure thing, spoken.",
			});

			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				kind: "peer",
				session_id: "conv.owner-1.alice.test-host.coolib.dev",
				from: "alice.test-host.coolib.dev",
				to: "alice.friend-gw.coolapp.dev",
				body: "sure thing",
				title: "t",
				summary: "s",
				fullSpoken: "Sure thing, spoken.",
			});
		});

		it("a console reply on a returnRoute job produces no peer mirror", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("conv.friend-conv.alice.test-host.coolib.dev", "alice.friend-gw.coolapp.dev", "coolib.dev", {
				persistent: true,
				returnRoute: {
					srcGateway: "friend-gw",
					srcConversationId: "friend-conv",
					srcSession: "conv.friend-conv.alice.test-host.coolib.dev",
				},
			});
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure("owner-1");
			const ctx = makeCtx({ store, mailboxStore, ownerId: () => "owner-1" });
			const { respond } = createRoutes(ctx);

			respond(
				new Request("http://gateway/respond"),
				{ session_id: "conv.friend-conv.alice.test-host.coolib.dev", response: "sure thing" },
				{ consoleSender: true },
			);

			expect(mailboxStore.get("owner-1")!.drain().entries).toHaveLength(0);
		});

		it("dedup: the same dedupeKey passed to the underlying mailbox append is idempotent across a retry", () => {
			// mirrorPeer's own dedupeKey generation is exercised structurally by the send()/respond()
			// tests above; this pins the guarantee those calls lean on - DeviceMailbox.append never
			// double-appends when the SAME dedupeKey recurs, which is what lets a future caller (or a
			// relayed console_push convergence copy) that DOES have a stable id dedupe correctly.
			const mailboxStore = new DeviceMailboxStore();
			const box = mailboxStore.ensure("owner-1");
			const entry = {
				kind: "peer" as const,
				session_id: "conv.owner-1.alice.test-host.coolib.dev",
				from: "alice.test-host.coolapp.dev",
				to: "alice.test-host.coolib.dev",
				body: "hello",
			};
			box.append(entry, "stable-key-1");
			box.append(entry, "stable-key-1");
			expect(box.drain().entries).toHaveLength(1);
		});
	});

	describe("consolePush (console_push landing side)", () => {
		it("lands an entry on the owner's mailbox, embedding the dedupeKey", () => {
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ mailboxStore, ownerId: () => "owner-1" });
			const { consolePush } = createRoutes(ctx);

			const entry = {
				kind: "peer" as const,
				session_id: "conv.owner-1.alice.test-host.coollib.dev",
				from: "a",
				to: "b",
			};
			const result = consolePush(entry, "dk-1");

			expect(result).toEqual({ delivered: true });
			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ ...entry, dedupeKey: "dk-1" });
		});

		it("drops an oversized plugin_action payload instead of landing it (defense-in-depth for a relayed entry)", () => {
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ mailboxStore, ownerId: () => "owner-1" });
			const { consolePush } = createRoutes(ctx);

			const entry = {
				kind: "plugin_action" as const,
				session_id: "conv.owner-1.alice.test-host.recipe-app.claude",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "x".repeat(40_000) },
			};
			const result = consolePush(entry, "dk-1");

			expect(result).toEqual({ delivered: false });
			expect(mailboxStore.get("owner-1")).toBeUndefined();
		});

		it("is idempotent: the same dedupeKey re-delivered (a relay retry) lands exactly once", () => {
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ mailboxStore, ownerId: () => "owner-1" });
			const { consolePush } = createRoutes(ctx);
			const entry = {
				kind: "notice" as const,
				session_id: "notice.alice.test-host.recipe-app.claude",
				from: "recipe-app",
			};

			consolePush(entry, "dk-retry");
			consolePush(entry, "dk-retry");

			expect(mailboxStore.get("owner-1")!.drain().entries).toHaveLength(1);
		});

		it("is a no-op (not an error) with no mailboxStore or no owner id", () => {
			const entry = {
				kind: "notice" as const,
				session_id: "notice.alice.test-host.recipe-app.claude",
				from: "recipe-app",
			};
			expect(createRoutes(makeCtx()).consolePush(entry, "dk-1")).toEqual({ delivered: false });
			expect(
				createRoutes(makeCtx({ mailboxStore: new DeviceMailboxStore() })).consolePush(entry, "dk-1"),
			).toEqual({ delivered: false });
		});

		it("drops (not appends) an entry whose files exceed the same byte cap send/respond/humanNotify enforce", () => {
			// A relayed console_push is the only mailbox-writing path that lands content this
			// Gateway did not itself already size-check - it must not get to skip the cap the
			// other three paths all apply before ever reaching the mailbox.
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ mailboxStore, ownerId: () => "owner-1" });
			const { consolePush } = createRoutes(ctx);
			const entry = {
				kind: "notice" as const,
				session_id: "notice.alice.test-host.recipe-app.claude",
				from: "recipe-app",
				// A declared size alone (no base64) is enough to cross the cap, and avoids actually
				// allocating a 500+ MB string in the test process.
				files: [
					{
						filename: "big.bin",
						mime: "application/octet-stream",
						size: MAX_RESPONSE_FILE_BYTES + 1,
						descriptiveKey: "b",
						role: "attachment" as const,
					},
				],
			};

			const result = consolePush(entry, "dk-big");

			expect(result).toEqual({ delivered: false });
			expect(mailboxStore.get("owner-1")?.drain().entries ?? []).toHaveLength(0);
		});

		it("degrades to delivered:false instead of throwing when the underlying append fails", () => {
			const throwingStore = {
				ensure: () => ({
					append: () => {
						throw new Error("boom");
					},
				}),
			};
			const ctx = makeCtx({ mailboxStore: throwingStore as never, ownerId: () => "owner-1" });
			const { consolePush } = createRoutes(ctx);
			const entry = {
				kind: "notice" as const,
				session_id: "notice.alice.test-host.recipe-app.claude",
				from: "recipe-app",
			};

			expect(() => consolePush(entry, "dk-1")).not.toThrow();
			expect(consolePush(entry, "dk-1")).toEqual({ delivered: false });
		});
	});
});
