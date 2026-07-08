import { describe, expect, it } from "vitest";
import { createRoutes, type RoutesDeps } from "../gateway/routes.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { SessionStore } from "../shared/session-store.js";
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
			localGatewayId: "test-host",
			localDomainId: "alice",
		},
		tryWakeTeam: overrides.tryWakeTeam || (() => Promise.resolve({ ok: false })),
		isWakeInFlight: overrides.isWakeInFlight,
		offlineCatalog,
		knownTeamPaths,
		mailboxStore: overrides.mailboxStore,
		sessionStore: overrides.sessionStore,
		displayName: overrides.displayName,
		isAdminDomain: overrides.isAdminDomain,
		touchShares: overrides.touchShares,
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

		it("lists a confirmed live record as online with its version, label, and mode", async () => {
			const sessionStore = new SessionStore();
			sessionStore.adoptById("main", { spawn: "proj-a", sessionLabel: "My Work" });
			const registry = makeRegistry({
				"proj-a.main": {
					readyState: 1,
					data: { mode: "channel", version: "5.0.14", handshakeConfirmed: true },
				},
			});
			const json = await createRoutes(makeCtx({ registry, sessionStore })).teams().json();
			expect(json).toEqual([
				{
					team: "proj-a.main",
					gatewayId: "test-host",
					domainId: "alice",
					status: "online",
					mode: "channel",
					kind: "loose",
					version: "5.0.14",
					sessionLabel: "My Work",
					queue_depth: 0,
				},
			]);
		});

		it("lists a live-but-unconfirmed record as verifying (re-registered, LLM not re-answered)", async () => {
			const sessionStore = new SessionStore();
			sessionStore.adoptById("main", { spawn: "proj-a", sessionLabel: "My Work" });
			const registry = makeRegistry({
				"proj-a.main": { readyState: 1, data: { mode: "channel", handshakeConfirmed: false } },
			});
			const json = (await createRoutes(makeCtx({ registry, sessionStore })).teams().json()) as {
				status: string;
			}[];
			expect(json[0]?.status).toBe("verifying");
		});

		it("lists a record with no live incarnation as available, with its recency and label", async () => {
			const sessionStore = new SessionStore({ now: () => 4242 });
			sessionStore.adoptById("main", { spawn: "proj-a", sessionLabel: "My Work" });
			const json = await createRoutes(makeCtx({ sessionStore })).teams().json();
			expect(json).toEqual([
				{
					team: "proj-a.main",
					gatewayId: "test-host",
					domainId: "alice",
					status: "available",
					kind: "loose",
					sessionLabel: "My Work",
					lastActive: 4242,
					queue_depth: 0,
				},
			]);
		});

		it("lists an asleep record with a wake in flight as verifying (coming up), not available", async () => {
			const sessionStore = new SessionStore();
			sessionStore.adoptById("main", { spawn: "proj-a", sessionLabel: "My Work" });
			const json = (await createRoutes(
				makeCtx({ sessionStore, isWakeInFlight: (team) => team === "proj-a.main" }),
			)
				.teams()
				.json()) as { status: string }[];
			expect(json[0]?.status).toBe("verifying");
		});

		it("resolves a record's status through its alias liveTeam when no canonical pane is registered", async () => {
			const sessionStore = new SessionStore();
			sessionStore.adoptById("abc", { spawn: "host", sessionLabel: "resumed" });
			// A manual `claude --resume` re-incarnation registered under a fresh self-composed name.
			sessionStore.confirm("host.abc", { team: "host.xyz", subId: "sub-1" });
			const registry = makeRegistry({
				"host.xyz": { readyState: 1, data: { mode: "channel", handshakeConfirmed: true } },
			});
			const json = (await createRoutes(makeCtx({ registry, sessionStore })).teams().json()) as {
				team: string;
				status: string;
			}[];
			// Folds into the record's own entry, never a second listing for the alias name.
			expect(json).toEqual([
				expect.objectContaining({ team: "host.abc", status: "online", sessionLabel: "resumed" }),
			]);
		});

		it("hides recordless live peers: a loose session that never confirmed, a virtual console, the host", async () => {
			const sessionStore = new SessionStore();
			const registry = makeRegistry({
				"host.flagless": { readyState: 1, data: { mode: "channel", handshakeConfirmed: false } },
				"Pixel 10 Pro XL": {
					readyState: 1,
					data: { virtual: true, mode: "channel", handshakeConfirmed: true },
				},
				host: { readyState: 1, data: { mode: "channel", handshakeConfirmed: true } },
			});
			const json = await createRoutes(makeCtx({ registry, sessionStore })).teams().json();
			expect(json).toEqual([]);
		});

		it("lists spawn-points from the catalog as available devcontainers alongside their session records", async () => {
			const sessionStore = new SessionStore();
			sessionStore.adoptById("main", { spawn: "proj-a", sessionLabel: "My Work" });
			const registry = makeRegistry({
				"proj-a.main": { readyState: 1, data: { mode: "channel", handshakeConfirmed: true } },
			});
			const offlineCatalog = new Map<string, string>([
				["proj-a", "/home/user/proj-a"],
				["proj-b", "/home/user/proj-b"],
			]);
			const json = (await createRoutes(makeCtx({ registry, sessionStore, offlineCatalog })).teams().json()) as {
				team: string;
				status: string;
				kind: string;
			}[];
			expect(json.map((t) => [t.team, t.status, t.kind])).toEqual([
				["proj-a.main", "online", "loose"],
				["proj-a", "available", "devcontainer"],
				["proj-b", "available", "devcontainer"],
			]);
		});

		it("stamps the local Domain id and display name on both records and spawn-points", async () => {
			const sessionStore = new SessionStore();
			sessionStore.adoptById("main", { spawn: "proj-a", sessionLabel: "My Work" });
			const registry = makeRegistry({
				"proj-a.main": { readyState: 1, data: { mode: "channel", handshakeConfirmed: true } },
			});
			const offlineCatalog = new Map<string, string>([["proj-b", "/home/user/proj-b"]]);
			const ctx = makeCtx({ registry, sessionStore, offlineCatalog, displayName: () => "Carol's Lab" });
			ctx.config.localDomainId = "sakura";
			const json = (await createRoutes(ctx).teams().json()) as {
				team: string;
				domainId?: string;
				displayName?: string;
			}[];
			expect(json.map((t) => [t.team, t.domainId, t.displayName])).toEqual([
				["proj-a.main", "sakura", "Carol's Lab"],
				["proj-b", "sakura", "Carol's Lab"],
			]);
		});

		it("OMITS displayName when the Gateway has none (minimal wire, unchanged for a pre-feature Gateway)", async () => {
			const offlineCatalog = new Map<string, string>([["proj-a", "/home/user/proj-a"]]);
			const ctx = makeCtx({ offlineCatalog, displayName: () => null });
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
					session_id: "notice.alice.test-host.recipe-app.claude",
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
			const registry = makeRegistry({ a: { readyState: 1, data: { mode: "channel" } } });
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
			// A composite spawn.session chat target (arity 2) resolves locally; with an empty
			// registry it is not connected and the wake fails, so the send 404s.
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b.dev",
				body: "hi",
			});
			expect(res.status).toBe(404);
			expect((await res.json()).error).toContain("not connected");
		});

		it("the not-found `available` list skips a non-slug Device Name registry key instead of throwing", async () => {
			// A console registers under a free-form human Device Name (not an address slug). A send that
			// 404s maps registry keys to canonical addresses for `available`; the device-name key must be
			// skipped (tryLocalAddress), not throw "invalid address segment".
			const registry = makeRegistry({ "Pixel 10 Pro XL": { readyState: 1, data: { mode: "channel" } } });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b.dev",
				body: "hi",
			});
			expect(res.status).toBe(404);
			expect((await res.json()).available).toEqual([]);
		});

		it("blocks a crosstalk send to the reserved host daemon with 400", async () => {
			const ctx = makeCtx();
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "proj-a",
				to: "host",
				body: "hi",
			});
			expect(res.status).toBe(400);
		});

		it("returns 404 when target ws.readyState !== 1", async () => {
			const registry = makeRegistry({ "b.dev": { readyState: 3, data: { mode: "channel" } } });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b.dev",
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
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			const json = await res.json();
			// The channel session id carries the canonical fully-qualified target
			// (conv.<conv>.<domain>.<gateway>.<spawn>.<session>) so the console threads
			// the reply under the resolved address.
			expect(json.session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
			expect(json.status).toBe("running");
			expect(pushed.length).toBe(1);
			expect(pushed[0].type).toBe("channel_push");
			expect((pushed[0] as { session_id: string }).session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
		});

		it("delivers to an alias re-incarnation via the record's liveTeam (no canonical pane)", async () => {
			const pushed: Record<string, unknown>[] = [];
			const aliasWs = {
				readyState: 1,
				data: { mode: "channel", teamName: "proj-a.alias", handshakeConfirmed: true },
				send(data: string) {
					pushed.push(JSON.parse(data));
				},
			};
			// The live socket is registered under a DIFFERENT name; nothing under proj-a.dev.
			const registry = makeRegistry({ "proj-a.alias": aliasWs });
			const sessionStore = new SessionStore();
			sessionStore.adoptById("dev", { spawn: "proj-a" });
			sessionStore.confirm("proj-a.dev", { team: "proj-a.alias", subId: "sub-1" });
			const { send } = createRoutes(makeCtx({ registry, sessionStore }));

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			const json = await res.json();
			// The session id keys on the TARGET record address, regardless of the alias delivery socket.
			expect(json.session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
			expect(pushed.length).toBe(1);
			expect((pushed[0] as { session_id: string }).session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
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
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			// The console targets the fully-qualified address; its (domain, gateway) is ours,
			// so the local-collapse rule resolves it to the local spawn.session registry entry.
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "alice.test-host.proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			const json = await res.json();
			expect(json.session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
			expect(pushed.length).toBe(1);
		});

		it("routes a target qualified with a different Gateway, 503 when the Router is down", async () => {
			const fakeWs = { readyState: 1, data: { mode: "channel" }, send() {} };
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			// No evieClient in this ctx: the Router is unavailable, so a cross-Gateway
			// target (an arity-4 address whose gateway differs from ours) reports 503
			// rather than misresolving to the same-named local session.
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "alice.other-host.proj-a.dev",
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
