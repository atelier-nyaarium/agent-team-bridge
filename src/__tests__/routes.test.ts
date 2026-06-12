import { describe, expect, it } from "vitest";
import { createRoutes, type RoutesDeps } from "../arbiter/routes.js";
import { Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";

/** Wrap a fake WebSocket into the nested registry structure: team → subId → ws */
function makeRegistry(entries: Record<string, unknown>): RoutesDeps["registry"] {
	const registry = new Map() as RoutesDeps["registry"];
	for (const [team, ws] of Object.entries(entries)) {
		const subs = new Map();
		subs.set("sub-1", ws);
		registry.set(team, subs);
	}
	return registry;
}

function makeCtx(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	const registry = overrides.registry || (new Map() as RoutesDeps["registry"]);
	const conversationRegistry = overrides.conversationRegistry || (new Map() as RoutesDeps["conversationRegistry"]);
	const store = overrides.store || new PendingJobStore<ResponsePayload>();
	const offlineCatalog = overrides.offlineCatalog || new Map<string, string>();
	const knownTeamPaths = overrides.knownTeamPaths || new Map<string, string>();
	const targetLocks = new Map<string, Mutex>();
	const getMutexFn = ((team: string) => {
		if (!targetLocks.has(team)) targetLocks.set(team, new Mutex());
		return targetLocks.get(team)!;
	}) as RoutesDeps["getMutex"];
	getMutexFn.peek = (team: string) => targetLocks.get(team);
	return {
		registry,
		conversationRegistry,
		store,
		getMutex: getMutexFn,
		config: { LOG_PATH: "/tmp/test-debug.log", RESPONSE_TIMEOUT_MS: 500 },
		tryWakeTeam: overrides.tryWakeTeam || (() => Promise.resolve(false)),
		offlineCatalog,
		knownTeamPaths,
		pinnedHolders: overrides.pinnedHolders || new Map<string, string | null>(),
		sessionToChannel: overrides.sessionToChannel || new Map<string, string>(),
		postSystemMessageToChannel: overrides.postSystemMessageToChannel || (() => Promise.resolve()),
	};
}

describe("routes", () => {
	describe("/pending", () => {
		it("returns empty array when no jobs", async () => {
			const ctx = makeCtx();
			const { pending } = createRoutes(ctx);
			const res = pending();
			expect(await res.json()).toEqual([]);
		});

		it("returns session_id, from, to, state for each pending job", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");
			const ctx = makeCtx({ store });
			const { pending } = createRoutes(ctx);
			const res = pending();
			expect(await res.json()).toEqual([{ session_id: "sess-1", from: "a", to: "b", state: "waiting" }]);
		});
	});

	describe("/teams", () => {
		it("returns empty array when registry empty", async () => {
			const ctx = makeCtx();
			const { teams } = createRoutes(ctx);
			const res = teams();
			expect(await res.json()).toEqual([]);
		});

		it("returns team info with queue_depth", async () => {
			const registry = makeRegistry({ "team-x": { readyState: 1, data: { mode: "cli" } } });
			const ctx = makeCtx({ registry });
			const mutex = ctx.getMutex("team-x");
			await mutex.acquire("id-1");

			const { teams } = createRoutes(ctx);
			const res = teams();
			expect(await res.json()).toEqual([
				{ team: "team-x", status: "online", mode: "cli", kind: "loose", queue_depth: 1 },
			]);
		});

		it("returns offline teams from catalog as available devcontainers", async () => {
			const offlineCatalog = new Map<string, string>();
			offlineCatalog.set("proj-a", "/home/user/proj-a");
			const ctx = makeCtx({ offlineCatalog });
			const { teams } = createRoutes(ctx);
			const res = teams();
			expect(await res.json()).toEqual([
				{ team: "proj-a", status: "available", kind: "devcontainer", queue_depth: 0 },
			]);
		});

		it("active teams take precedence over catalog", async () => {
			const registry = makeRegistry({ "proj-a": { readyState: 1, data: { mode: "cli" } } });
			const offlineCatalog = new Map<string, string>();
			offlineCatalog.set("proj-a", "/home/user/proj-a");
			offlineCatalog.set("proj-b", "/home/user/proj-b");
			const ctx = makeCtx({ registry, offlineCatalog });
			const { teams } = createRoutes(ctx);
			const res = teams();
			const json = await res.json();
			expect(json).toEqual([
				{ team: "proj-a", status: "online", mode: "cli", kind: "devcontainer", queue_depth: 0 },
				{ team: "proj-b", status: "available", kind: "devcontainer", queue_depth: 0 },
			]);
		});

		it("flags online teams as devcontainer via knownTeamPaths even when the catalog is empty", async () => {
			// offlineCatalog clears when the host daemon disconnects; knownTeamPaths
			// is the durable fallback, so catalog loss must not demote a project.
			const registry = makeRegistry({
				"proj-a": { readyState: 1, data: { mode: "channel" } },
				"2fb1f8": { readyState: 1, data: { mode: "channel" } },
			});
			const knownTeamPaths = new Map<string, string>([["proj-a", "/home/user/proj-a"]]);
			const ctx = makeCtx({ registry, knownTeamPaths });
			const { teams } = createRoutes(ctx);
			const json = await teams().json();
			expect(json).toEqual([
				{ team: "proj-a", status: "online", mode: "channel", kind: "devcontainer", queue_depth: 0 },
				{ team: "2fb1f8", status: "online", mode: "channel", kind: "loose", queue_depth: 0 },
			]);
		});
	});

	describe("/human/notify", () => {
		async function makeStoreWithPhones(): Promise<{
			ctx: RoutesDeps;
			mailboxStore: import("../shared/device-mailbox.js").DeviceMailboxStore;
		}> {
			const { DeviceMailboxStore } = await import("../shared/device-mailbox.js");
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure("phone-a");
			mailboxStore.ensure("phone-b");
			const ctx = { ...makeCtx(), mailboxStore };
			return { ctx, mailboxStore };
		}

		it("broadcasts a notice to every phone mailbox, threaded under the sender", async () => {
			const { ctx, mailboxStore } = await makeStoreWithPhones();
			const { humanNotify } = createRoutes(ctx);
			const res = humanNotify({ from: "recipe-app", tiny: "cycle done", full: "# report\n\nall good" });
			expect((await res.json()).delivered).toBe(2);
			for (const conv of ["phone-a", "phone-b"]) {
				const snap = mailboxStore.get(conv)!.drain();
				expect(snap.entries).toHaveLength(1);
				expect(snap.entries[0]).toMatchObject({
					kind: "notice",
					session_id: "notice:recipe-app",
					from: "recipe-app",
					title: "cycle done",
					body: "# report\n\nall good",
				});
			}
		});

		it("falls back to tiny as the body and wakes a held poll", async () => {
			const { ctx, mailboxStore } = await makeStoreWithPhones();
			const { humanNotify } = createRoutes(ctx);
			const box = mailboxStore.get("phone-a")!;
			const start = Date.now();
			const held = box.waitForAppend(10_000);
			humanNotify({ from: "t", tiny: "ping" });
			await held;
			expect(Date.now() - start).toBeLessThan(2_000);
			expect(box.drain().entries[0].body).toBe("ping");
		});

		it("rejects oversized attachments with 413 and missing store with 503", async () => {
			const { ctx } = await makeStoreWithPhones();
			const { humanNotify } = createRoutes(ctx);
			const huge = "A".repeat(14_000_001);
			const res = humanNotify({
				from: "t",
				tiny: "big",
				files: [
					{ filename: "b.bin", mime: "application/octet-stream", size: 0, descriptiveKey: "b", base64: huge },
				],
			});
			expect(res.status).toBe(413);

			const { humanNotify: noStore } = createRoutes(makeCtx());
			expect(noStore({ from: "t", tiny: "x" }).status).toBe(503);
		});
	});

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
			store.create("sess-files", "agent", "phone");
			const ctx = makeCtx({ store });
			const { respond } = createRoutes(ctx);
			const huge = "A".repeat(14_000_001); // ~10.5 MB decoded, over the 10 MB cap
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "sess-files",
				response: "here",
				files: [
					{
						filename: "big.bin",
						mime: "application/octet-stream",
						size: 0,
						descriptiveKey: "big.bin",
						base64: huge,
					},
				],
			});
			expect(res.status).toBe(413);
		});

		it("stores file metadata without base64 but pushes the full bytes", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-files", "agent", "phone");
			await store.waitForResult("sess-files", 1); // settle so the result is poll-recoverable
			const ctx = makeCtx({ store });
			const { respond, poll } = createRoutes(ctx);
			const b64 = Buffer.from("hello bytes").toString("base64");
			respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "sess-files",
				response: "screenshot attached",
				files: [{ filename: "shot.png", mime: "image/png", size: 11, descriptiveKey: "shot.png", base64: b64 }],
			});
			// The stored (poll-recoverable) result keeps metadata only, no base64.
			const polled = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "sess-files" });
			const body = (await polled.json()) as ResponsePayload;
			expect(body.files?.[0]).toMatchObject({ filename: "shot.png", mime: "image/png" });
			expect(body.files?.[0].base64).toBeUndefined();
		});
	});

	describe("/poll", () => {
		it("returns 400 when session_id missing", async () => {
			const ctx = makeCtx();
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), {});
			expect(res.status).toBe(400);
		});

		it("returns 404 when no pending job", async () => {
			const ctx = makeCtx();
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "nope" });
			expect(res.status).toBe(404);
		});

		it("returns running when job is timed out but no result yet", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");
			await store.waitForResult("sess-1", 1); // 1ms timeout
			await new Promise((r) => setTimeout(r, 10)); // let timeout fire

			const ctx = makeCtx({ store });
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "sess-1" });
			const json = await res.json();
			expect(json.status).toBe("running");
		});

		it("returns stored result after late delivery", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");
			await store.waitForResult("sess-1", 1);
			await new Promise((r) => setTimeout(r, 10));

			store.deliver("sess-1", { session_id: "sess-1", status: "completed", response: "late answer" });

			const ctx = makeCtx({ store });
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "sess-1" });
			const json = await res.json();
			expect(json.status).toBe("completed");
			expect(json.response).toBe("late answer");
		});
	});

	describe("/health", () => {
		it("returns ok with counts", async () => {
			const registry = makeRegistry({ a: { readyState: 1, data: { mode: "cli" } } });
			const store = new PendingJobStore<ResponsePayload>();
			store.create("s1", "a", "b");
			const ctx = makeCtx({ registry, store });
			const { health } = createRoutes(ctx);
			const res = health();
			expect(await res.json()).toEqual({ ok: true, teams: 1, pending_jobs: 1 });
		});
	});

	describe("/send", () => {
		it("returns 404 when target not in registry", async () => {
			const ctx = makeCtx();
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
			});
			expect(res.status).toBe(404);
			expect((await res.json()).error).toContain("not connected");
		});

		it("returns 404 when target ws.readyState !== 1", async () => {
			const registry = makeRegistry({ b: { readyState: 3, data: { mode: "cli" } } });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
			});
			expect(res.status).toBe(404);
		});

		it("sends inject payload and returns response when delivered inline", async () => {
			const sent: Record<string, unknown>[] = [];
			const fakeWs = {
				readyState: 1,
				data: { mode: "cli" },
				send(data: string) {
					sent.push(JSON.parse(data));
				},
			};
			const registry = makeRegistry({ b: fakeWs });
			const store = new PendingJobStore<ResponsePayload>();
			const ctx = makeCtx({ registry, store });
			const { send } = createRoutes(ctx);

			const promise = send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				type: "question",
				body: "hi",
			});

			await new Promise((r) => setTimeout(r, 10));

			// Deliver via the store (simulating /respond)
			const jobs = store.listAll();
			expect(jobs.length).toBe(1);
			const deliverResult = store.deliver(jobs[0].id, {
				session_id: jobs[0].id,
				status: "completed",
				response: "answer",
			});
			expect(deliverResult).toBeTruthy();

			const res = await promise;
			const json = await res.json();

			expect(sent.length).toBe(1);
			expect(sent[0].type).toBe("inject");
			expect(sent[0].from).toBe("a");
			expect(json.status).toBe("completed");
			expect(json.response).toBe("answer");
		});

		it("includes debug fields when debug=true", async () => {
			const fakeWs = { readyState: 1, data: { mode: "cli" }, send() {} };
			const registry = makeRegistry({ b: fakeWs });
			const store = new PendingJobStore<ResponsePayload>();
			const ctx = makeCtx({ registry, store });
			const { send } = createRoutes(ctx);

			const promise = send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
				debug: true,
			});
			await new Promise((r) => setTimeout(r, 10));

			const jobs = store.listAll();
			store.deliver(jobs[0].id, { session_id: jobs[0].id, status: "completed" });

			const res = await promise;
			const json = await res.json();

			expect(json.session_id).toBeDefined();
			expect(json.from).toBe("a");
			expect(json.to).toBe("b");
		});

		it("returns running when no response in time", async () => {
			const fakeWs = { readyState: 1, data: { mode: "cli" }, send() {} };
			const registry = makeRegistry({ b: fakeWs });
			const ctx = makeCtx({ registry });
			ctx.config.RESPONSE_TIMEOUT_MS = 50;
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
			});
			const json = await res.json();

			expect(json.status).toBe("running");
			expect(json.session_id).toBeDefined();
		}, 10000);

		it("rejects a channelOnly send to an online CLI team with 409", async () => {
			const fakeWs = { readyState: 1, data: { mode: "cli" }, send() {} };
			const registry = makeRegistry({ "cli-team": fakeWs });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "cli-team",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(409);
			expect((await res.json()).error).toContain("CLI-mode");
		});

		it("rejects a channelOnly send to a SLEEPING CLI team woken by the send (no random session id)", async () => {
			// The team is offline at send time; the wake brings up a CLI-mode agent.
			// Without channelOnly this fell into the CLI branch and minted a random
			// uuid session. With it, the post-wake mode check returns a clean 409.
			const registry = makeRegistry({});
			const cliWs = { readyState: 1, data: { mode: "cli" }, send() {} };
			const ctx = makeCtx({
				registry,
				tryWakeTeam: (team: string) => {
					const subs = new Map();
					subs.set("sub-1", cliWs);
					registry.set(team, subs as never);
					return Promise.resolve(true);
				},
			});
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "sleepy-cli",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(409);
			const json = await res.json();
			expect(json.error).toContain("CLI-mode");
			expect(json.session_id).toBeUndefined();
		}, 10000);

		it("channelOnly send to a channel team proceeds with the deterministic session id", async () => {
			const pushed: Record<string, unknown>[] = [];
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel" },
				send(data: string) {
					pushed.push(JSON.parse(data));
				},
			};
			const registry = makeRegistry({ "proj-a": fakeWs });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a",
				body: "hi",
				channelOnly: true,
			});
			const json = await res.json();
			expect(json.session_id).toBe("conv:conv-1:proj-a");
			expect(json.status).toBe("running");
			expect(pushed.length).toBe(1);
			expect(pushed[0].type).toBe("channel_push");
		});

		it("late delivery is stored and pollable after timeout", async () => {
			const fakeWs = { readyState: 1, data: { mode: "cli" }, send() {} };
			const registry = makeRegistry({ b: fakeWs });
			const store = new PendingJobStore<ResponsePayload>();
			const ctx = makeCtx({ registry, store });
			ctx.config.RESPONSE_TIMEOUT_MS = 50;
			const routes = createRoutes(ctx);

			const sendRes = await routes.send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
			});
			const sendJson = await sendRes.json();
			expect(sendJson.status).toBe("running");

			// Late delivery
			store.deliver(sendJson.session_id, {
				session_id: sendJson.session_id,
				status: "completed",
				response: "late answer",
			});

			// Poll should return the stored result
			const pollRes = routes.poll(new Request("http://localhost/poll", { method: "POST" }), {
				session_id: sendJson.session_id,
			});
			const pollJson = await pollRes.json();
			expect(pollJson.status).toBe("completed");
			expect(pollJson.response).toBe("late answer");
		}, 10000);
	});
});
