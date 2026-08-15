import { describe, expect, it, vi } from "vitest";
import { createRoutes, MAX_RESPONSE_FILE_BYTES, type RoutesDeps } from "../gateway/routes.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { SessionStore } from "../shared/session-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { makeCtx, makeRegistry } from "./helpers/routes.js";

describe("routes", () => {
	describe("/respond", () => {
		it("returns 400 when session_id missing", async () => {
			const ctx = makeCtx();
			const { respond } = createRoutes(ctx);
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {});
			expect(res.status).toBe(400);
		});

		it("returns 404 when no pending job", async () => {
			const ctx = makeCtx();
			const { respond } = createRoutes(ctx);
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), { session_id: "nope" });
			expect(res.status).toBe(404);
		});

		it("absorbs a reply to an awareness push instead of 404ing an agent that did nothing wrong", () => {
			// Nothing can ENFORCE no-reply, and an id with no job entry falls through to store.deliver,
			// misses, and reaches the agent as a tool error for answering a message that asked for none.
			const { respond } = createRoutes(makeCtx());
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "na-0123456789abcdef",
				response: "ok",
			});
			expect(res.status).toBe(200);
		});

		it("does not absorb a reply to a REAL job that merely looks like an awareness push", () => {
			// A federated peer names its own return-route key, so the prefix alone would let it park a
			// job here and have the intercept swallow the answer while the agent is told it was sent.
			const store = new PendingJobStore<ResponsePayload>();
			store.create("na-hijack", "friend.session", "proj.main", { persistent: true });
			const { respond } = createRoutes(makeCtx({ store }));
			const waiting = store.waitForResult("na-hijack", 10_000);
			respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "na-hijack",
				status: "completed",
				response: "the answer",
			});
			return expect(waiting).resolves.toMatchObject({ result: { response: "the answer" } });
		});

		it("delivers result to waiting job and returns delivered", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");

			let waitResult: unknown = null;
			const waitPromise = store.waitForResult("sess-1", 10_000).then((r) => {
				waitResult = r;
			});

			const ctx = makeCtx({ store });
			const { respond } = createRoutes(ctx);
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "sess-1",
				status: "completed",
				response: "done",
			});

			await waitPromise;
			expect(await res.json()).toEqual({ delivered: true });
			expect(waitResult).toEqual({
				delivered: true,
				result: expect.objectContaining({ status: "completed", response: "done" }),
			});
		});

		it("rejects an oversized attachment payload with 413", () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-files", "agent", "console");
			const ctx = makeCtx({ store });
			const { respond } = createRoutes(ctx);
			// A declared size alone (no base64) is enough to cross the cap, and avoids
			// actually allocating a 500+ MB string in the test process.
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "sess-files",
				response: "here",
				files: [
					{
						filename: "big.bin",
						mime: "application/octet-stream",
						size: MAX_RESPONSE_FILE_BYTES + 1,
						descriptiveKey: "big.bin",
						role: "attachment",
					},
				],
			});
			expect(res.status).toBe(413);
		});

		it("mints a materialization bucket key on a reply that carries files, and none on one that does not", async () => {
			async function pushFor(files?: unknown[]): Promise<Record<string, unknown>> {
				const sent: string[] = [];
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-push", "agent", "console", { fromConversationId: "conv-asker" });
				const conversationRegistry = new Map([
					["conv-asker", { readyState: 1, data: {}, send: (m: string) => sent.push(m) }],
				]) as unknown as RoutesDeps["conversationRegistry"];
				const { respond } = createRoutes(makeCtx({ store, conversationRegistry }));
				respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-push",
					response: "reply",
					...(files ? { files } : {}),
				});
				return JSON.parse(sent[0]);
			}

			const withFiles = await pushFor([
				{
					filename: "shot.png",
					mime: "image/png",
					size: 5,
					descriptiveKey: "shot.png",
					role: "attachment",
					base64: Buffer.from("bytes").toString("base64"),
				},
			]);
			expect(withFiles.message_id).toEqual(expect.any(String));
			expect(withFiles.files).toHaveLength(1);

			const withoutFiles = await pushFor();
			expect(withoutFiles.message_id).toBeUndefined();
		});

		it("stores a reply's filenames but never a reference that would fetch their bytes", async () => {
			// `/pending` enumerates every session id and `/poll` authorizes nobody, so anything in the
			// store is readable by whoever can reach the port - and a channel entry is persistent and
			// never swept. A blobId there is not metadata, it is a bearer token for the content:
			// `/blob/get` hands the bytes to anyone who can name them. Naming the file is the most a
			// stored copy may do.
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-files", "agent", "console");
			await store.waitForResult("sess-files", 1); // settle so the result is poll-recoverable
			const ctx = makeCtx({ store });
			const { respond, poll } = createRoutes(ctx);
			const blobId = `sha256-${"a".repeat(64)}`;
			respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "sess-files",
				response: "screenshot attached",
				files: [
					{
						filename: "shot.png",
						mime: "image/png",
						size: 11,
						descriptiveKey: "shot.png",
						role: "attachment",
						blobId,
					},
				],
			});

			const polled = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "sess-files" });
			const body = (await polled.json()) as ResponsePayload;
			expect(body.files?.[0]).toEqual({
				filename: "shot.png",
				mime: "image/png",
				size: 11,
				descriptiveKey: "shot.png",
				// The role survives the strip: it is display metadata, not a capability, and a stored
				// entry carrying it explicitly is what lets the strict decoder eventually exist.
				role: "attachment",
			});
			expect(body.files?.[0].blobId).toBeUndefined();
			expect(JSON.stringify(body)).not.toContain(blobId);
		});

		it("refuses a file that never says what it is, rather than guessing a role for it", async () => {
			// Absence is not a state anyone interprets. A sender that cannot name a role is malformed,
			// and refusing it at the edge is what stops a receiver from having to guess a role from other
			// fields on the file instead.
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-roleless", "agent", "console");
			await store.waitForResult("sess-roleless", 1);
			const ctx = makeCtx({ store });
			const { respond } = createRoutes(ctx);

			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "sess-roleless",
				response: "no role on this file",
				files: [{ filename: "shot.png", mime: "image/png", size: 1, descriptiveKey: "shot.png" }],
			});

			expect(res.status).toBe(400);
		});

		describe("reply gate (an unconfirmed caller's own bridge handshake)", () => {
			/** A fake registered socket, just shaped enough for the gate's own checks. */
			function makeCallerWs(overrides: {
				readyState?: number;
				virtual?: boolean;
				handshakeConfirmed?: boolean;
				teamName?: string | null;
				subId?: string;
			}) {
				return {
					readyState: overrides.readyState ?? 1,
					data: {
						virtual: overrides.virtual ?? false,
						handshakeConfirmed: overrides.handshakeConfirmed ?? false,
						teamName: overrides.teamName ?? "recipe-app.abc123",
						subId: overrides.subId ?? "s1",
					},
				} as unknown as RoutesDeps["conversationRegistry"] extends Map<string, infer V> ? V : never;
			}

			it("rejects 409, without disclosing the pending handshake id, when the caller's own socket is unconfirmed", async () => {
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-gate-1", "agent", "console");
				const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
				conversationRegistry.set("conv-1", makeCallerWs({ handshakeConfirmed: false }));
				const ctx = makeCtx({
					store,
					conversationRegistry,
					findPendingHandshake: (team, subId) =>
						team === "recipe-app.abc123" && subId === "s1" ? "hs-pending123" : undefined,
				});
				const { respond } = createRoutes(ctx);
				const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-1",
					response: "done",
					conversationId: "conv-1",
				});
				expect(res.status).toBe(409);
				const body = (await res.json()) as { error: string };
				expect(body.error).not.toContain("hs-pending123");
				expect(body.error).toEqual(expect.any(String));
			});

			it("delivers once the caller's own socket is confirmed", async () => {
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-gate-2", "agent", "console");
				const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
				conversationRegistry.set("conv-2", makeCallerWs({ handshakeConfirmed: true }));
				const ctx = makeCtx({
					store,
					conversationRegistry,
					findPendingHandshake: () => "hs-should-not-matter",
				});
				const { respond } = createRoutes(ctx);
				const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-2",
					response: "done",
					conversationId: "conv-2",
				});
				expect(res.status).toBe(200);
			});

			it("fails open when the reply carries no conversationId", async () => {
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-gate-3", "agent", "console");
				const ctx = makeCtx({ store, findPendingHandshake: () => "hs-irrelevant" });
				const { respond } = createRoutes(ctx);
				const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-3",
					response: "done",
				});
				expect(res.status).toBe(200);
			});

			it("fails open when the conversationId is not in the registry (stale id / reconnect race)", async () => {
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-gate-4", "agent", "console");
				const ctx = makeCtx({
					store,
					conversationRegistry: new Map() as RoutesDeps["conversationRegistry"],
					findPendingHandshake: () => "hs-irrelevant",
				});
				const { respond } = createRoutes(ctx);
				const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-4",
					response: "done",
					conversationId: "conv-missing",
				});
				expect(res.status).toBe(200);
			});

			it("fails open when the unconfirmed socket has no pending handshake entry", async () => {
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-gate-5", "agent", "console");
				const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
				conversationRegistry.set("conv-5", makeCallerWs({ handshakeConfirmed: false }));
				const ctx = makeCtx({ store, conversationRegistry, findPendingHandshake: () => undefined });
				const { respond } = createRoutes(ctx);
				const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-5",
					response: "done",
					conversationId: "conv-5",
				});
				expect(res.status).toBe(200);
			});

			it("re-pushes the caller's own pending handshake before bouncing", async () => {
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-gate-6", "agent", "console");
				const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
				conversationRegistry.set("conv-6", makeCallerWs({ handshakeConfirmed: false }));
				const repushHandshake = vi.fn().mockReturnValue("pushed");
				const ctx = makeCtx({
					store,
					conversationRegistry,
					findPendingHandshake: () => "hs-pending-6",
					repushHandshake,
				});
				const { respond } = createRoutes(ctx);
				const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-6",
					response: "done",
					conversationId: "conv-6",
				});
				expect(res.status).toBe(409);
				expect(repushHandshake).toHaveBeenCalledWith("recipe-app.abc123", "s1");
				const body = (await res.json()) as { error: string };
				expect(body.error).not.toContain("hs-pending-6");
				expect(body.error).toEqual(expect.any(String));
			});

			it("escalates the 409 message once repushHandshake reports the attempt cap was hit", async () => {
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-gate-7", "agent", "console");
				const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
				conversationRegistry.set("conv-7", makeCallerWs({ handshakeConfirmed: false }));
				const ctx = makeCtx({
					store,
					conversationRegistry,
					findPendingHandshake: () => "hs-pending-7",
					repushHandshake: () => "capped",
				});
				const { respond } = createRoutes(ctx);
				const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-7",
					response: "done",
					conversationId: "conv-7",
				});
				expect(res.status).toBe(409);
				const body = (await res.json()) as { error: string };
				expect(body.error).not.toContain("hs-pending-7");
				expect(body.error).toEqual(expect.any(String));
			});

			it("gives a distinct 409 message when repushHandshake reports the re-push itself could not be delivered", async () => {
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-gate-7b", "agent", "console");
				const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
				conversationRegistry.set("conv-7b", makeCallerWs({ handshakeConfirmed: false }));
				const ctx = makeCtx({
					store,
					conversationRegistry,
					findPendingHandshake: () => "hs-pending-7b",
					repushHandshake: () => "socket-gone",
				});
				const { respond } = createRoutes(ctx);
				const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-7b",
					response: "done",
					conversationId: "conv-7b",
				});
				expect(res.status).toBe(409);
				const body = (await res.json()) as { error: string };
				expect(body.error).toEqual(expect.any(String));
			});

			it("end-to-end: a reply blocked by the gate lands once the caller confirms and resends", async () => {
				const store = new PendingJobStore<ResponsePayload>();
				store.create("sess-gate-8", "agent", "console");
				const conversationRegistry = new Map() as RoutesDeps["conversationRegistry"];
				const callerWs = makeCallerWs({ handshakeConfirmed: false });
				conversationRegistry.set("conv-8", callerWs);
				const ctx = makeCtx({
					store,
					conversationRegistry,
					findPendingHandshake: () => "hs-pending-8",
					repushHandshake: () => "pushed",
				});
				const { respond } = createRoutes(ctx);

				const blocked = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-8",
					response: "done",
					conversationId: "conv-8",
				});
				expect(blocked.status).toBe(409);

				// The caller answers the re-pushed handshake (simulated: its socket flips confirmed) and
				// resends the exact same reply - the job was never delivered by the blocked attempt, so
				// it is still pending.
				callerWs.data.handshakeConfirmed = true;
				const landed = respond(new Request("http://localhost/respond", { method: "POST" }), {
					session_id: "sess-gate-8",
					response: "done",
					conversationId: "conv-8",
				});
				expect(landed.status).toBe(200);
			});
		});
	});

	describe("/respond console durability", () => {
		const req = new Request("http://gateway/respond");

		it("appends a reply to the device mailbox even when no live peer exists", () => {
			// The class-4 case: after a restart the mailbox is restored but the virtual
			// peer is not rehydrated, so conversationRegistry has no entry for the console.
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "team-a", "console", { persistent: true, fromConversationId: "console-conv" });
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure("console-conv"); // mailbox restored, no conversationRegistry peer
			const ctx = makeCtx({ store, mailboxStore });
			const { respond } = createRoutes(ctx);

			const res = respond(req, { session_id: "sess-1", status: "completed", response: "the answer" });
			expect(res.status).toBe(200);

			const drained = mailboxStore.get("console-conv")?.drain(0);
			expect(drained?.entries.length).toBe(1);
			expect(drained?.entries[0]).toMatchObject({ kind: "reply", body: "the answer", status: "completed" });
		});

		it("stamps the spoken tiers onto the mailbox reply entry", () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "team-a", "console", { persistent: true, fromConversationId: "console-conv" });
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure("console-conv");
			const ctx = makeCtx({ store, mailboxStore });
			const { respond } = createRoutes(ctx);

			respond(req, {
				session_id: "sess-1",
				status: "completed",
				response: "# the answer",
				title: "t",
				summary: "s",
				fullSpoken: "The answer, spoken.",
			});
			expect(mailboxStore.get("console-conv")?.drain(0)?.entries[0]).toMatchObject({
				kind: "reply",
				body: "# the answer",
				title: "t",
				summary: "s",
				fullSpoken: "The answer, spoken.",
			});
		});

		it("does not create a spurious mailbox for a channel agent (no mailbox = live-WS path)", () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-2", "team-b", "agent", { persistent: true, fromConversationId: "agent-conv" });
			const mailboxStore = new DeviceMailboxStore();
			const ctx = makeCtx({ store, mailboxStore });
			const { respond } = createRoutes(ctx);

			respond(req, { session_id: "sess-2", status: "completed", response: "reply" });
			// A channel agent has no mailbox; respond must not mint one for it.
			expect(mailboxStore.get("agent-conv")).toBeUndefined();
		});
	});
});

// A channel job id is a pure function of two non-secret values, so anyone who has exchanged one
// message can compute it forever after. Delivery is therefore gated on who is actually serving the
// conversation, not on knowing its id.
describe("reply ownership on /respond", () => {
	function servedBy(boundToken?: string) {
		const sessionStore = new SessionStore();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		const team = sessionStore.teamOf(record);
		if (boundToken) {
			record.bindToken = boundToken;
			sessionStore.activateBinding(record);
		}
		const ws = { readyState: 1, send: vi.fn(), data: { handshakeConfirmed: true, boundToken } };
		const registry = makeRegistry({ [team]: ws });
		sessionStore.bindBySegment(team, { live: { team, subId: "s1" } });
		const store = new PendingJobStore<ResponsePayload>();
		store.create("job-1", "asker", team, {});
		return { ctx: makeCtx({ registry, sessionStore, store }), team };
	}

	function reqWith(token?: string): Request {
		return new Request("http://gateway/respond", { headers: token ? { "x-session-token": token } : {} });
	}

	it("refuses a reply from anyone other than the session serving that conversation", () => {
		const { ctx } = servedBy("victim-token");
		const { respond } = createRoutes(ctx);

		const res = respond(reqWith(), { session_id: "job-1", response: "forged" });

		expect(res.status).toBe(403);
	});

	it("accepts the reply from the session that is serving it", async () => {
		const { ctx } = servedBy("victim-token");
		const { respond } = createRoutes(ctx);

		const res = respond(reqWith("victim-token"), { session_id: "job-1", response: "real" });

		expect(await res.json()).toMatchObject({ delivered: true });
	});

	it("accepts a reply for a conversation served by an unbound session, which has nothing to prove", async () => {
		const { ctx } = servedBy();
		const { respond } = createRoutes(ctx);

		const res = respond(reqWith(), { session_id: "job-1", response: "real" });

		expect(await res.json()).toMatchObject({ delivered: true });
	});
});

// A session is asleep most of the time, which is exactly when forging into its conversation is
// easiest, so ownership must survive the target having no live socket.
describe("reply ownership for an offline target", () => {
	function offlineBound() {
		const sessionStore = new SessionStore();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		record.bindToken = "victim-token";
		sessionStore.activateBinding(record);
		const team = sessionStore.teamOf(record);
		const store = new PendingJobStore<ResponsePayload>();
		store.create("job-1", "asker", team, {});
		return makeCtx({ registry: makeRegistry({}), sessionStore, store });
	}

	function reqWith(token?: string): Request {
		return new Request("http://gateway/respond", { headers: token ? { "x-session-token": token } : {} });
	}

	it("refuses a forged reply while the target session is asleep", () => {
		const { respond } = createRoutes(offlineBound());

		expect(respond(reqWith(), { session_id: "job-1", response: "forged" }).status).toBe(403);
	});

	it("still accepts the real session's own reply after it wakes", async () => {
		const { respond } = createRoutes(offlineBound());

		const res = respond(reqWith("victim-token"), { session_id: "job-1", response: "real" });

		expect(await res.json()).toMatchObject({ delivered: true });
	});
});
