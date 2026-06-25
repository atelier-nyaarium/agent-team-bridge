import { describe, expect, it } from "vitest";
import { createRoutes, type RoutesDeps } from "../gateway/routes.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
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
	return {
		registry,
		conversationRegistry,
		store,
		config: {
			LOG_PATH: "/tmp/test-debug.log",
			RESPONSE_TIMEOUT_MS: 500,
			localGatewayId: "test-host",
			localDomainId: "alice",
		},
		tryWakeTeam: overrides.tryWakeTeam || (() => Promise.resolve(false)),
		offlineCatalog,
		knownTeamPaths,
		mailboxStore: overrides.mailboxStore,
		displayName: overrides.displayName,
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

		it("returns offline teams from catalog as available devcontainers", async () => {
			const offlineCatalog = new Map<string, string>();
			offlineCatalog.set("proj-a", "/home/user/proj-a");
			const ctx = makeCtx({ offlineCatalog });
			const { teams } = createRoutes(ctx);
			const res = teams();
			expect(await res.json()).toEqual([
				{
					team: "proj-a",
					gatewayId: "test-host",
					domainId: "alice",
					status: "available",
					kind: "devcontainer",
					queue_depth: 0,
				},
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
				{
					team: "proj-a",
					gatewayId: "test-host",
					domainId: "alice",
					status: "online",
					mode: "cli",
					kind: "devcontainer",
					queue_depth: 0,
				},
				{
					team: "proj-b",
					gatewayId: "test-host",
					domainId: "alice",
					status: "available",
					kind: "devcontainer",
					queue_depth: 0,
				},
			]);
		});

		it("surfaces the plugin version an online team reported at register", async () => {
			const registry = makeRegistry({
				"proj-a": { readyState: 1, data: { mode: "channel", version: "5.0.14" } },
			});
			const ctx = makeCtx({ registry });
			const json = (await createRoutes(ctx).teams().json()) as { team: string; version?: string }[];
			expect(json[0]?.version).toBe("5.0.14");
		});

		it("omits version for a team whose socket reported none (pre-feature plugin / console peer)", async () => {
			const registry = makeRegistry({ "proj-a": { readyState: 1, data: { mode: "channel" } } });
			const ctx = makeCtx({ registry });
			const json = (await createRoutes(ctx).teams().json()) as { team: string; version?: string }[];
			expect(json[0]?.version).toBeUndefined();
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
				{
					team: "proj-a",
					gatewayId: "test-host",
					domainId: "alice",
					status: "online",
					mode: "channel",
					kind: "devcontainer",
					queue_depth: 0,
				},
				{
					team: "2fb1f8",
					gatewayId: "test-host",
					domainId: "alice",
					status: "online",
					mode: "channel",
					kind: "loose",
					queue_depth: 0,
				},
			]);
		});

		it("marks a team whose only socket is a virtual console peer as kind console", async () => {
			const registry = makeRegistry({
				"proj-a": { readyState: 1, data: { mode: "channel" } },
				Aqua: { readyState: 1, data: { virtual: true, mode: "channel" } },
			});
			const knownTeamPaths = new Map<string, string>([["proj-a", "/home/user/proj-a"]]);
			const ctx = makeCtx({ registry, knownTeamPaths });
			const json = await createRoutes(ctx).teams().json();
			expect(json).toEqual([
				{
					team: "proj-a",
					gatewayId: "test-host",
					domainId: "alice",
					status: "online",
					mode: "channel",
					kind: "devcontainer",
					queue_depth: 0,
				},
				{
					team: "Aqua",
					gatewayId: "test-host",
					domainId: "alice",
					status: "online",
					mode: "channel",
					kind: "console",
					queue_depth: 0,
				},
			]);
		});

		it("marks the gateway channel identity as kind switch (the host-agent)", async () => {
			const registry = makeRegistry({
				gateway: { readyState: 1, data: { mode: "channel" } },
				"proj-a": { readyState: 1, data: { mode: "channel" } },
			});
			const knownTeamPaths = new Map<string, string>([["proj-a", "/home/user/proj-a"]]);
			const ctx = makeCtx({ registry, knownTeamPaths });
			const json = await createRoutes(ctx).teams().json();
			expect(json).toEqual([
				{
					team: "gateway",
					gatewayId: "test-host",
					domainId: "alice",
					status: "online",
					mode: "channel",
					kind: "gateway",
					queue_depth: 0,
				},
				{
					team: "proj-a",
					gatewayId: "test-host",
					domainId: "alice",
					status: "online",
					mode: "channel",
					kind: "devcontainer",
					queue_depth: 0,
				},
			]);
		});

		it("stamps the local Domain id on every team (the (domainId, gatewayId) pair addresses a session)", async () => {
			const registry = makeRegistry({ "proj-a": { readyState: 1, data: { mode: "channel" } } });
			const offlineCatalog = new Map<string, string>([["proj-b", "/home/user/proj-b"]]);
			const ctx = makeCtx({ registry, offlineCatalog });
			ctx.config.localDomainId = "sakura";
			const json = (await createRoutes(ctx).teams().json()) as { team: string; domainId?: string }[];
			// Both the online registry team and the offline-catalog team carry the configured
			// local Domain id; a colliding friend gateway id is disambiguated by this pair.
			expect(json.map((t) => [t.team, t.domainId])).toEqual([
				["proj-a", "sakura"],
				["proj-b", "sakura"],
			]);
		});

		it("excludes the cli host wake-daemon from the listing", async () => {
			const registry = makeRegistry({
				host: { readyState: 1, data: { mode: "cli" } },
				"team-a": { readyState: 1, data: { mode: "channel" } },
			});
			const ctx = makeCtx({ registry });
			const json = (await createRoutes(ctx).teams().json()) as { team: string }[];
			expect(json.map((t) => t.team)).toEqual(["team-a"]);
		});

		it("stamps the Gateway's display name on every team so Peers see the network label (D1)", async () => {
			const registry = makeRegistry({ "proj-a": { readyState: 1, data: { mode: "channel" } } });
			const offlineCatalog = new Map<string, string>([["proj-b", "/home/user/proj-b"]]);
			const ctx = makeCtx({ registry, offlineCatalog, displayName: () => "Carol's Lab" });
			const json = (await createRoutes(ctx).teams().json()) as { team: string; displayName?: string }[];
			expect(json.map((t) => [t.team, t.displayName])).toEqual([
				["proj-a", "Carol's Lab"],
				["proj-b", "Carol's Lab"],
			]);
		});

		it("OMITS displayName when the Gateway has none (minimal wire, unchanged for a pre-feature Gateway)", async () => {
			const registry = makeRegistry({ "proj-a": { readyState: 1, data: { mode: "channel" } } });
			const ctx = makeCtx({ registry, displayName: () => null });
			const json = (await createRoutes(ctx).teams().json()) as Record<string, unknown>[];
			expect(json[0]).not.toHaveProperty("displayName");
		});
	});

	describe("/human/notify", () => {
		async function makeStoreWithConsoles(): Promise<{
			ctx: RoutesDeps;
			mailboxStore: import("../shared/device-mailbox.js").DeviceMailboxStore;
		}> {
			const { DeviceMailboxStore } = await import("../shared/device-mailbox.js");
			const mailboxStore = new DeviceMailboxStore();
			mailboxStore.ensure("console-a");
			mailboxStore.ensure("console-b");
			const ctx = { ...makeCtx(), mailboxStore };
			return { ctx, mailboxStore };
		}

		it("broadcasts a notice to every console mailbox, threaded under the sender", async () => {
			const { ctx, mailboxStore } = await makeStoreWithConsoles();
			const { humanNotify } = createRoutes(ctx);
			const res = humanNotify({
				from: "recipe-app",
				title: "cycle done",
				summary: "All phases shipped. Nothing is blocked.",
				full: "# report\n\nall good",
			});
			expect((await res.json()).delivered).toBe(2);
			for (const conv of ["console-a", "console-b"]) {
				const snap = mailboxStore.get(conv)!.drain();
				expect(snap.entries).toHaveLength(1);
				expect(snap.entries[0]).toMatchObject({
					kind: "notice",
					session_id: "notice:test-host/recipe-app",
					from: "recipe-app",
					title: "cycle done",
					summary: "All phases shipped. Nothing is blocked.",
					body: "# report\n\nall good",
				});
			}
		});

		it("accepts the title key and rejects a notice carrying no title", async () => {
			const { ctx, mailboxStore } = await makeStoreWithConsoles();
			const { humanNotify } = createRoutes(ctx);
			humanNotify({ from: "recipe-app", title: "via title", summary: "s", full: "body" });
			expect(mailboxStore.get("console-a")!.drain().entries[0]).toMatchObject({ title: "via title" });
			expect(humanNotify({ from: "t", summary: "s", full: "body" }).status).toBe(400);
		});

		it("requires title, summary, and full (no ghost pings) and wakes a held poll", async () => {
			const { ctx, mailboxStore } = await makeStoreWithConsoles();
			const { humanNotify } = createRoutes(ctx);
			// Notices missing summary/full are rejected outright.
			expect(humanNotify({ from: "t", title: "ping" }).status).toBe(400);
			expect(humanNotify({ from: "t", title: "ping", summary: "s" }).status).toBe(400);
			const box = mailboxStore.get("console-a")!;
			const start = Date.now();
			const held = box.waitForAppend(10_000);
			humanNotify({ from: "t", title: "ping", summary: "s", full: "body" });
			await held;
			expect(Date.now() - start).toBeLessThan(2_000);
			expect(box.drain().entries[0].body).toBe("body");
		});

		it("rejects oversized attachments with 413 and missing store with 503", async () => {
			const { ctx } = await makeStoreWithConsoles();
			const { humanNotify } = createRoutes(ctx);
			const huge = "A".repeat(14_000_001);
			const res = humanNotify({
				from: "t",
				title: "big",
				summary: "s",
				full: "body",
				files: [
					{ filename: "b.bin", mime: "application/octet-stream", size: 0, descriptiveKey: "b", base64: huge },
				],
			});
			expect(res.status).toBe(413);

			const { humanNotify: noStore } = createRoutes(makeCtx());
			expect(noStore({ from: "t", title: "x", summary: "s", full: "body" }).status).toBe(503);
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
			store.create("sess-files", "agent", "console");
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
			store.create("sess-files", "agent", "console");
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

		it("blocks a non-console (crosstalk) send to the host-agent with 400", async () => {
			const ctx = makeCtx();
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "proj-a",
				to: "gateway",
				body: "hi",
			});
			expect(res.status).toBe(400);
		});

		it("lets a console (channelOnly) send past the reserved guard to the host-agent", async () => {
			// channelOnly send to "gateway" clears the 400 guard; with no gateway
			// registered here it then 404s, proving it got past the reserved block.
			const ctx = makeCtx();
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				to: "gateway",
				channelOnly: true,
				body: "hi",
			});
			expect(res.status).toBe(404);
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
			// The channel session id carries the canonical host-qualified target so
			// the console threads the reply under (gatewayId, name).
			expect(json.session_id).toBe("conv:conv-1:test-host/proj-a");
			expect(json.status).toBe("running");
			expect(pushed.length).toBe(1);
			expect(pushed[0].type).toBe("channel_push");
			expect((pushed[0] as { session_id: string }).session_id).toBe("conv:conv-1:test-host/proj-a");
		});

		it("resolves a host-qualified local target to the local session", async () => {
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

			// The console targets the qualified name; the gateway strips the local
			// host and resolves to the bare registry entry.
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "test-host/proj-a",
				body: "hi",
				channelOnly: true,
			});
			const json = await res.json();
			expect(json.session_id).toBe("conv:conv-1:test-host/proj-a");
			expect(pushed.length).toBe(1);
		});

		it("routes a target qualified with a different Gateway, 503 when the Router is down", async () => {
			const fakeWs = { readyState: 1, data: { mode: "channel" }, send() {} };
			const registry = makeRegistry({ "proj-a": fakeWs });
			// No evieClient in this ctx: the Router is unavailable, so a cross-Gateway
			// target reports 503 rather than misresolving to the same-named local
			// session.
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "other-host/proj-a",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(503);
			expect((await res.json()).error).toContain("Router unavailable");
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
