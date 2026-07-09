import { describe, expect, it, vi } from "vitest";
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
		ownerId: overrides.ownerId,
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
			// A declared size alone (no base64) is enough to cross the cap, and avoids
			// actually allocating a 500+ MB string in the test process.
			const res = humanNotify({
				from: "t",
				title: "big",
				summary: "s",
				full: "body",
				files: [
					{
						filename: "b.bin",
						mime: "application/octet-stream",
						size: 500_000_001,
						descriptiveKey: "b",
					},
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
			// A declared size alone (no base64) is enough to cross the cap, and avoids
			// actually allocating a 500+ MB string in the test process.
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "sess-files",
				response: "here",
				files: [
					{
						filename: "big.bin",
						mime: "application/octet-stream",
						size: 500_000_001,
						descriptiveKey: "big.bin",
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

		it("a not-yet-existing composite with no displayLabel fails fast instead of silently adopting the typed name", async () => {
			const wakeCalls: Array<{ team: string; createOpts?: { displayLabel?: string; mintedFrom?: string } }> = [];
			const tryWakeTeam = (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => {
				wakeCalls.push({ team, createOpts });
				return Promise.resolve({
					ok: false,
					error: `"proj-a.newsession" does not exist yet; retry with a displayLabel to create it`,
				});
			};
			const ctx = makeCtx({ tryWakeTeam });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.newsession",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe(
				`"proj-a.newsession" does not exist yet; retry with a displayLabel to create it`,
			);
			// The wake carries a provenance key derived from (fromConversationId, to) even though this
			// attempt has no displayLabel, so a retry that DOES supply one still reattaches correctly.
			expect(wakeCalls).toEqual([
				{
					team: "proj-a.newsession",
					createOpts: { displayLabel: undefined, mintedFrom: "conv-1:proj-a.newsession" },
				},
			]);
		});

		it("a not-yet-existing composite with a displayLabel mints and switches to the resolved address for everything downstream", async () => {
			vi.useFakeTimers();
			try {
				const pushed: Record<string, unknown>[] = [];
				const mintedWs = {
					readyState: 1,
					data: { mode: "channel" },
					send(data: string) {
						pushed.push(JSON.parse(data));
					},
				};
				// The minted record's live incarnation registers under the freshly-minted id, never the
				// typed one - nothing is registered under "proj-a.newsession" at all.
				const registry = makeRegistry({ "proj-a.minted1": mintedWs });
				const wakeCalls: Array<{ team: string; createOpts?: { displayLabel?: string; mintedFrom?: string } }> =
					[];
				const tryWakeTeam = (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => {
					wakeCalls.push({ team, createOpts });
					return Promise.resolve({ ok: true, resolvedTeam: "proj-a.minted1" });
				};
				const ctx = makeCtx({ registry, tryWakeTeam });
				const { send } = createRoutes(ctx);

				const resPromise = send(new Request("http://localhost/send", { method: "POST" }), {
					from: "pixel",
					fromConversationId: "conv-1",
					to: "proj-a.newsession",
					body: "hi",
					channelOnly: true,
					displayLabel: "Bug Hunt",
				});
				await vi.advanceTimersByTimeAsync(3000);
				const json = await (await resPromise).json();

				// The wake is requested against the TYPED address (the minted one does not exist to wake
				// yet), carrying the displayLabel and a provenance key derived from the RESOLVED local
				// name (which happens to equal the typed `to` here, since it was already the short form).
				expect(wakeCalls).toEqual([
					{
						team: "proj-a.newsession",
						createOpts: { displayLabel: "Bug Hunt", mintedFrom: "conv-1:proj-a.newsession" },
					},
				]);
				// Everything downstream of the wake - the reply and the channel push - addresses the
				// MINTED session, never the address the caller originally typed.
				expect(json.session_id).toBe("conv.conv-1.alice.test-host.proj-a.minted1");
				expect(pushed.length).toBe(1);
				expect((pushed[0] as { session_id: string }).session_id).toBe(
					"conv.conv-1.alice.test-host.proj-a.minted1",
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("mintedFrom is keyed on the RESOLVED local name, not the caller's raw spelling - two valid spellings of the same target agree", async () => {
			// The same local target can be legally spelled two ways: a short local form, and a
			// self-qualified domain.gateway.spawn.session form (the local-collapse rule folds the
			// latter onto the former). A caller who discovers a session via crosstalk_discover (which
			// renders the qualified form) and later retries using that exact string must still land on
			// the SAME mintedFrom a short-form retry would have used - otherwise the two spellings mint
			// two different sessions for what the caller believes is one retry.
			const wakeCalls: Array<{ team: string; createOpts?: { displayLabel?: string; mintedFrom?: string } }> = [];
			const tryWakeTeam = (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => {
				wakeCalls.push({ team, createOpts });
				return Promise.resolve({ ok: false, error: "not found" });
			};
			const ctx = makeCtx({ tryWakeTeam });
			const { send } = createRoutes(ctx);

			await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.newsession",
				body: "hi",
				channelOnly: true,
				displayLabel: "Bug Hunt",
			});
			await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				// The fully-qualified spelling of the identical local target (our own domain/gateway).
				to: "alice.test-host.proj-a.newsession",
				body: "hi again",
				channelOnly: true,
				displayLabel: "Bug Hunt",
			});

			expect(wakeCalls).toHaveLength(2);
			expect(wakeCalls[0].createOpts?.mintedFrom).toBe(wakeCalls[1].createOpts?.mintedFrom);
			expect(wakeCalls[0].team).toBe(wakeCalls[1].team);
		});

		it("a trusted-inbound (federated) send derives mintedFrom from its own inboundSessionId (the real call shape: no fromConversationId of its own)", async () => {
			const wakeCalls: Array<{ team: string; createOpts?: { displayLabel?: string; mintedFrom?: string } }> = [];
			const tryWakeTeam = (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => {
				wakeCalls.push({ team, createOpts });
				return Promise.resolve({ ok: false, error: "not found" });
			};
			const ctx = makeCtx({ tryWakeTeam });
			const { send } = createRoutes(ctx);

			// Mirrors gatewayRelay.ts's actual "send" case body: no fromConversationId is ever set
			// alongside sessionId/returnRoute on a trusted-inbound call, so this does not (and cannot)
			// prove inboundSessionId wins over a competing fromConversationId - only that it is used
			// when fromConversationId is absent, the one shape the real caller produces.
			await send(
				new Request("http://localhost/send", { method: "POST" }),
				{
					from: "alice.friend-gw.proj-a.dev",
					to: "proj-a.newsession",
					body: "hi",
					channelOnly: true,
					displayLabel: "Bug Hunt",
					sessionId: "conv.friend-conv.alice.test-host.proj-a.newsession",
					returnRoute: {
						srcGateway: "friend-gw",
						srcConversationId: "friend-conv",
						srcSession: "conv.friend-conv.alice.test-host.proj-a.newsession",
					},
				},
				{ trustedInbound: true },
			);
			expect(wakeCalls).toEqual([
				{
					team: "proj-a.newsession",
					createOpts: {
						displayLabel: "Bug Hunt",
						mintedFrom: "conv.friend-conv.alice.test-host.proj-a.newsession",
					},
				},
			]);
		});
	});

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
				{ session_id: "conv.conv-1.alice.gw2.coolib.dev", response: "on it" },
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
			});

			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				kind: "peer",
				session_id: "conv.owner-1.alice.test-host.coolib.dev",
				from: "alice.test-host.coolib.dev",
				to: "alice.friend-gw.coolapp.dev",
				body: "sure thing",
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
