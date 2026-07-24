import { describe, expect, it, vi } from "vitest";
import { PresenceFacade } from "../gateway/presence.js";
import { createRoutes, MAX_RESPONSE_FILE_BYTES, type RoutesDeps } from "../gateway/routes.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation } from "../gateway/websocket.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { SessionStore } from "../shared/session-store.js";
import type { ResponsePayload } from "../shared/types.js";

const TEST_REQ = new Request("http://gateway/test");

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

/** Builds a real PresenceFacade wired to the same registry/offlineCatalog/sessionStore a test's
 * RoutesDeps uses, so /teams exercises the actual production computation instead of a second,
 * parallel one. Call `.wakeStart(team)` on the returned facade to simulate a wake in flight - the
 * facade owns that state itself now (no more external isWakeInFlight predicate feeding it). */
function makePresence(opts: {
	registry: RoutesDeps["registry"];
	offlineCatalog: Map<string, string>;
	sessionStore?: SessionStore;
	localDomainId?: () => string | null;
	displayName?: RoutesDeps["displayName"];
	isAdminDomain?: RoutesDeps["isAdminDomain"];
}): PresenceFacade {
	const facade = new PresenceFacade({
		sessionStore: opts.sessionStore ?? new SessionStore(),
		registry: opts.registry,
		offlineCatalog: opts.offlineCatalog,
		localGatewayId: "test-host",
		localDomainId: opts.localDomainId ?? (() => "alice"),
		displayName: opts.displayName ?? (() => null),
		isAdminDomain: opts.isAdminDomain ?? (() => null),
	});
	facade.attach(new PlaneRegistry());
	facade.registerPlane();
	return facade;
}

function makeCtx(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	const registry = overrides.registry || (new Map() as RoutesDeps["registry"]);
	const conversationRegistry = overrides.conversationRegistry || (new Map() as RoutesDeps["conversationRegistry"]);
	const store = overrides.store || new PendingJobStore<ResponsePayload>();
	const offlineCatalog = overrides.offlineCatalog || new Map<string, string>();
	const knownTeamPaths = overrides.knownTeamPaths || new Map<string, string>();
	const config = { localGatewayId: "test-host", localDomainId: "alice" };
	return {
		registry,
		conversationRegistry,
		store,
		config,
		auth: createSessionAuthority({
			sessionStore: overrides.sessionStore,
			registry,
			resolveLive: resolveLiveIncarnation,
			localDomainId: () => config.localDomainId,
			localGatewayId: config.localGatewayId,
		}),
		tryWakeTeam: overrides.tryWakeTeam || (() => Promise.resolve({ ok: false })),
		isWakeInFlight: overrides.isWakeInFlight,
		offlineCatalog,
		knownTeamPaths,
		mailboxStore: overrides.mailboxStore,
		sessionStore: overrides.sessionStore,
		presence:
			overrides.presence ||
			makePresence({
				registry,
				offlineCatalog,
				sessionStore: overrides.sessionStore,
				// Reads `config.localDomainId` LAZILY (at snapshot time, not construction time) so a
				// test that mutates `ctx.config.localDomainId` after calling makeCtx (a pre-existing
				// pattern in this file) is still honored.
				localDomainId: () => config.localDomainId,
				displayName: overrides.displayName,
				isAdminDomain: overrides.isAdminDomain,
			}),
		displayName: overrides.displayName,
		isAdminDomain: overrides.isAdminDomain,
		touchShares: overrides.touchShares,
		sharesFor: overrides.sharesFor,
		crossDomainPresenceConsumer: overrides.crossDomainPresenceConsumer,
		ownerId: overrides.ownerId,
		resolveHandshake: overrides.resolveHandshake,
		findPendingHandshake: overrides.findPendingHandshake,
		repushHandshake: overrides.repushHandshake,
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
			const registry = new Map() as RoutesDeps["registry"];
			const offlineCatalog = new Map<string, string>();
			const presence = makePresence({ registry, offlineCatalog, sessionStore });
			presence.wakeStart("proj-a.main");
			const json = (await createRoutes(makeCtx({ sessionStore, registry, offlineCatalog, presence }))
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
			// Rows come back sorted by team (presence.snapshot()'s stable-hashing requirement), not
			// insertion order: "proj-a" sorts before "proj-a.main" as a string prefix.
			expect(json.map((t) => [t.team, t.status, t.kind])).toEqual([
				["proj-a", "available", "devcontainer"],
				["proj-a.main", "online", "loose"],
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
		function makeStoreForOwner(owner = "owner-1"): {
			ctx: RoutesDeps;
			mailboxStore: DeviceMailboxStore;
		} {
			// Deliberately NOT pre-`ensure()`-ing the owner's mailbox: this is the ordinary shape
			// for a Gateway no console has ever registered against (a multi-gateway Domain's
			// non-home Gateway), which is exactly the case humanNotify must not silently drop.
			const mailboxStore = new DeviceMailboxStore();
			const ctx = { ...makeCtx({ mailboxStore, ownerId: () => owner }) };
			return { ctx, mailboxStore };
		}

		it("delivers a notice into the owner's mailbox, threaded under the sender, even with zero pre-registered devices", async () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			const res = humanNotify(TEST_REQ, {
				from: "recipe-app",
				title: "cycle done",
				summary: "All phases shipped. Nothing is blocked.",
				full: "# report\n\nall good",
			});
			expect((await res.json()).delivered).toBe(true);
			const snap = mailboxStore.get("owner-1")!.drain();
			expect(snap.entries).toHaveLength(1);
			expect(snap.entries[0]).toMatchObject({
				kind: "notice",
				session_id: "notice.alice.test-host.recipe-app.claude",
				from: "recipe-app",
				title: "cycle done",
				summary: "All phases shipped. Nothing is blocked.",
				body: "# report\n\nall good",
			});
			// Embeds its own dedupeKey (matching mirrorPeer's convention) so a relayed
			// console_push convergence copy on a sibling Gateway dedupes against the same value.
			expect(typeof snap.entries[0].dedupeKey).toBe("string");
		});

		it("accepts the title key and rejects a notice carrying no title", async () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			humanNotify(TEST_REQ, { from: "recipe-app", title: "via title", summary: "s", full: "body" });
			expect(mailboxStore.get("owner-1")!.drain().entries[0]).toMatchObject({ title: "via title" });
			expect(humanNotify(TEST_REQ, { from: "t", summary: "s", full: "body" }).status).toBe(400);
		});

		it("stamps fullSpoken onto the notice entry, and still accepts a notice WITHOUT it", async () => {
			// Optional here despite being required on the tool schema: the strict gateway schema
			// would otherwise 400 every notice from a not-yet-reloaded plugin in a deploy window.
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			const withSpoken = await humanNotify(TEST_REQ, {
				from: "recipe-app",
				title: "t",
				summary: "s",
				full: "# body",
				fullSpoken: "Spoken body.",
			}).json();
			expect(withSpoken.delivered).toBe(true);
			const without = await humanNotify(TEST_REQ, {
				from: "recipe-app",
				title: "t2",
				summary: "s2",
				full: "b2",
			}).json();
			expect(without.delivered).toBe(true);
			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries[0]).toMatchObject({ fullSpoken: "Spoken body." });
			expect(entries[1].fullSpoken).toBeUndefined();
		});

		it("requires title, summary, and full (no ghost pings) and wakes a held poll", async () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			// Notices missing summary/full are rejected outright, before any mailbox is even ensured.
			expect(humanNotify(TEST_REQ, { from: "t", title: "ping" }).status).toBe(400);
			expect(humanNotify(TEST_REQ, { from: "t", title: "ping", summary: "s" }).status).toBe(400);
			expect(mailboxStore.get("owner-1")).toBeUndefined();
			const start = Date.now();
			const held = mailboxStore.ensure("owner-1").waitForAppend(10_000);
			humanNotify(TEST_REQ, { from: "t", title: "ping", summary: "s", full: "body" });
			await held;
			expect(Date.now() - start).toBeLessThan(2_000);
			expect(mailboxStore.get("owner-1")!.drain().entries[0].body).toBe("body");
		});

		it("rejects oversized attachments with 413, missing store with 503, and no owner (pre-enrollment) with 503", async () => {
			const { ctx } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			// A declared size alone (no base64) is enough to cross the cap, and avoids
			// actually allocating a 500+ MB string in the test process.
			const res = humanNotify(TEST_REQ, {
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
			expect(noStore(TEST_REQ, { from: "t", title: "x", summary: "s", full: "body" }).status).toBe(503);

			const { humanNotify: noOwner } = createRoutes(makeCtx({ mailboxStore: new DeviceMailboxStore() }));
			expect(noOwner(TEST_REQ, { from: "t", title: "x", summary: "s", full: "body" }).status).toBe(503);
		});

		it("returns a clean 500 instead of throwing when the underlying append fails", () => {
			const throwingStore = {
				ensure: () => ({
					append: () => {
						throw new Error("boom");
					},
				}),
			};
			const ctx = makeCtx({ mailboxStore: throwingStore as never, ownerId: () => "owner-1" });
			const { humanNotify } = createRoutes(ctx);

			expect(() => humanNotify(TEST_REQ, { from: "t", title: "x", summary: "s", full: "body" })).not.toThrow();
			expect(humanNotify(TEST_REQ, { from: "t", title: "x", summary: "s", full: "body" }).status).toBe(500);
		});
	});

	describe("/plugin-action", () => {
		function makeStoreForOwner(owner = "owner-1"): {
			ctx: RoutesDeps;
			mailboxStore: DeviceMailboxStore;
		} {
			const mailboxStore = new DeviceMailboxStore();
			const ctx = { ...makeCtx({ mailboxStore, ownerId: () => owner }) };
			return { ctx, mailboxStore };
		}

		it("delivers a plugin_action into the owner's mailbox, threaded under the caller's own address", async () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			const res = pluginAction(TEST_REQ, {
				from: "recipe-app",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "editor-form.html" },
			});
			expect((await res.json()).delivered).toBe(true);
			const snap = mailboxStore.get("owner-1")!.drain();
			expect(snap.entries).toHaveLength(1);
			expect(snap.entries[0]).toMatchObject({
				kind: "plugin_action",
				session_id: "conv.owner-1.alice.test-host.recipe-app.claude",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "editor-form.html" },
			});
			expect(typeof snap.entries[0].dedupeKey).toBe("string");
		});

		it("cannot be made to target any address other than the caller's own resolved identity", async () => {
			// The schema is strict: there is no "to"/"target"/"team" field at all, so a caller
			// cannot smuggle a different destination through the request body - only `from` (the
			// caller's own name) ever decides the target.
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			const res = pluginAction(TEST_REQ, {
				from: "recipe-app",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "x.html", to: "someone-elses-team", team: "someone-elses-team" },
				to: "someone-elses-team",
				target: "someone-elses-team",
			} as Record<string, unknown>);
			expect(res.status).toBe(400);
			// Even a same-shaped call with no stray top-level fields (a lookalike key buried only
			// inside the opaque payload, which the composer never reads for addressing) still
			// resolves to the caller's own address, not the lookalike value.
			pluginAction(TEST_REQ, {
				from: "recipe-app",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "x.html", to: "someone-elses-team", team: "someone-elses-team" },
			});
			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries).toHaveLength(1);
			expect(entries[0].session_id).toBe("conv.owner-1.alice.test-host.recipe-app.claude");
		});

		it("requires from, pluginId, and actionType", async () => {
			const { ctx } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			expect(pluginAction(TEST_REQ, { pluginId: "designer", actionType: "delete-card" }).status).toBe(400);
			expect(pluginAction(TEST_REQ, { from: "recipe-app", actionType: "delete-card" }).status).toBe(400);
			expect(pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "designer" }).status).toBe(400);
		});

		it("rejects an invalid `from` session name with 400 rather than throwing", () => {
			const { ctx } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			expect(() =>
				pluginAction(TEST_REQ, { from: "Not A Valid Slug!", pluginId: "designer", actionType: "delete-card" }),
			).not.toThrow();
			expect(
				pluginAction(TEST_REQ, { from: "Not A Valid Slug!", pluginId: "designer", actionType: "delete-card" })
					.status,
			).toBe(400);
		});

		it("missing store returns 503, no owner (pre-enrollment) returns 503", () => {
			const { pluginAction: noStore } = createRoutes(makeCtx());
			expect(
				noStore(TEST_REQ, { from: "recipe-app", pluginId: "designer", actionType: "delete-card" }).status,
			).toBe(503);

			const { pluginAction: noOwner } = createRoutes(makeCtx({ mailboxStore: new DeviceMailboxStore() }));
			expect(
				noOwner(TEST_REQ, { from: "recipe-app", pluginId: "designer", actionType: "delete-card" }).status,
			).toBe(503);
		});

		it("rejects a pluginId or actionType containing a colon, so two distinct pairs can never collide onto the same composite claim key", () => {
			const { ctx } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			expect(pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "a:b", actionType: "c" }).status).toBe(400);
			expect(pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "a", actionType: "b:c" }).status).toBe(400);
			expect(
				pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "Designer", actionType: "delete-card" }).status,
			).toBe(400);
		});

		it("rejects a payload over the size cap, so an oversized entry can never reach the mailbox", () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			const res = pluginAction(TEST_REQ, {
				from: "recipe-app",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "x".repeat(40_000) },
			});
			expect(res.status).toBe(400);
			expect(mailboxStore.get("owner-1")).toBeUndefined();
		});

		it("returns a clean 500 instead of throwing when the underlying append fails", () => {
			const throwingStore = {
				ensure: () => ({
					append: () => {
						throw new Error("boom");
					},
				}),
			};
			const ctx = makeCtx({ mailboxStore: throwingStore as never, ownerId: () => "owner-1" });
			const { pluginAction } = createRoutes(ctx);

			expect(() =>
				pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "designer", actionType: "delete-card" }),
			).not.toThrow();
			expect(
				pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "designer", actionType: "delete-card" }).status,
			).toBe(500);
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
					{ filename: "big.bin", mime: "application/octet-stream", size: 500_000_001, descriptiveKey: "b" },
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
				expect(body.error).toContain("handshake");
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
				expect(body.error).toContain("resend this reply");
				expect(body.error.toLowerCase()).not.toContain("stale");
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
				expect(body.error.toLowerCase()).toContain("stale");
				expect(body.error).not.toContain("hs-pending-7");
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
				expect(body.error).toContain("could not be re-delivered");
				expect(body.error.toLowerCase()).not.toContain("stale");
				expect(body.error).not.toContain("resend this reply");
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

		it("delivers to a live but unconfirmed (still verifying) socket - send() carries no handshake gate", async () => {
			const pushed: Record<string, unknown>[] = [];
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel", handshakeConfirmed: false },
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
			expect(res.status).toBe(200);
			expect(pushed.length).toBe(1);
		});

		it("re-pushes an unconfirmed recipient's handshake ahead of the message, then still delivers", async () => {
			const events: string[] = [];
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel", handshakeConfirmed: false, teamName: "proj-a.dev", subId: "sub-1" },
				send(data: string) {
					events.push((JSON.parse(data) as { type: string }).type);
				},
			};
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			const repushHandshake = vi.fn().mockImplementation(() => {
				events.push("handshake-repush");
				return "pushed";
			});
			const ctx = makeCtx({ registry, repushHandshake });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(200);
			expect(repushHandshake).toHaveBeenCalledWith("proj-a.dev", "sub-1");
			expect(events).toEqual(["handshake-repush", "channel_push"]);
		});

		it("never re-pushes a handshake for a confirmed recipient", async () => {
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel", handshakeConfirmed: true, teamName: "proj-a.dev", subId: "sub-1" },
				send() {},
			};
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			const repushHandshake = vi.fn();
			const ctx = makeCtx({ registry, repushHandshake });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(200);
			expect(repushHandshake).not.toHaveBeenCalled();
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

	describe("presenceForDomain (cross-Domain presence)", () => {
		it("skips an offlineCatalog row with a non-slug team name instead of throwing", () => {
			// A real devcontainer directory name (uppercase, underscore, space, or >64 chars) is
			// never slug-validated at offlineCatalog intake - presenceForDomain must skip it via
			// tryLocalAddress, never crash the whole gateway via the throwing localAddress.
			const offlineCatalog = new Map([["MyApp", "/projects/MyApp"]]);
			const { presenceForDomain } = createRoutes(makeCtx({ offlineCatalog }));
			expect(() => presenceForDomain("bob-domain")).not.toThrow();
			expect(presenceForDomain("bob-domain")).toEqual([]);
		});

		it("caches presence.snapshot() for one synchronous burst of calls, not once per Domain", () => {
			let snapshotCalls = 0;
			const presence = {
				snapshot: () => {
					snapshotCalls += 1;
					return [];
				},
			};
			const { presenceForDomain } = createRoutes(makeCtx({ presence }));
			presenceForDomain("bob-domain");
			presenceForDomain("carol-domain");
			presenceForDomain("dave-domain");
			expect(snapshotCalls).toBe(1);
		});

		it("refreshes the cached snapshot on the next tick, so a later unrelated caller is never stale", async () => {
			let snapshotCalls = 0;
			const presence = {
				snapshot: () => {
					snapshotCalls += 1;
					return [];
				},
			};
			const { presenceForDomain } = createRoutes(makeCtx({ presence }));
			presenceForDomain("bob-domain");
			await Promise.resolve(); // let the queued microtask clear the cache
			presenceForDomain("bob-domain");
			expect(snapshotCalls).toBe(2);
		});

		it("invalidatePresenceSnapshotCache forces a fresh read within the SAME tick, without waiting for a microtask", () => {
			let snapshotCalls = 0;
			const presence = {
				snapshot: () => {
					snapshotCalls += 1;
					return [];
				},
			};
			const { presenceForDomain, invalidatePresenceSnapshotCache } = createRoutes(makeCtx({ presence }));
			presenceForDomain("bob-domain");
			invalidatePresenceSnapshotCache();
			// Still the same synchronous tick - no await, no microtask flush - yet this must recompute,
			// since two genuinely separate recomputeAll() passes can each fire within one tick (e.g. a
			// reconnect's evict-then-confirm) and must never compare against each other's stale reading.
			presenceForDomain("carol-domain");
			expect(snapshotCalls).toBe(2);
		});

		it("pullPresenceFromDomain resolves null for a Domain with no linked gateway at all", async () => {
			const { pullPresenceFromDomain } = createRoutes(makeCtx({}));
			await expect(pullPresenceFromDomain("bob-domain")).resolves.toBeNull();
		});

		it("pullPresenceFromDomain resolves null when every one of the Domain's gateways is unreachable", async () => {
			// No evieClient wired in this ctx, so relayToGateway fails closed for every gateway -
			// exactly the "reached none of them" case that must never be confused with "reached them
			// and they genuinely share nothing" (which resolves an empty array, not null).
			const crossDomainPeers = {
				all: () => [{ friendDomainId: "bob-domain", friendGatewayId: "bob-gw", friendOwnerSignPub: "x" }],
			} as unknown as import("../gateway/federation/crossDomainPeers.js").CrossDomainPeers;
			const { pullPresenceFromDomain } = createRoutes(makeCtx({ crossDomainPeers }));
			await expect(pullPresenceFromDomain("bob-domain")).resolves.toBeNull();
		});
	});

	describe("constants", () => {
		it("MAX_RESPONSE_FILE_BYTES matches the Android console's own MAX_OUTGOING_BYTES", () => {
			// android/.../ChatRepository.kt: const val MAX_OUTGOING_BYTES = 500_000_000
			expect(MAX_RESPONSE_FILE_BYTES).toBe(500_000_000);
		});
	});
});

// The HTTP routes are the other half of the identity gate: a name whose binding is active belongs to
// one session, so naming it in `from` requires proving you are it. Absence of the header must be a
// refusal rather than a fallback, or dropping it would be all impersonation ever took.
describe("HTTP sender ownership", () => {
	function boundCtx() {
		const sessionStore = new SessionStore();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		const token = sessionStore.ensureBindToken(record);
		sessionStore.activateBinding(record);
		const team = sessionStore.teamOf(record);
		const mailboxStore = new DeviceMailboxStore();
		mailboxStore.ensure("owner-1");
		return { ctx: makeCtx({ sessionStore, mailboxStore, ownerId: () => "owner-1" }), team, token };
	}

	function reqWith(token?: string): Request {
		return new Request("http://gateway/x", { headers: token ? { "x-session-token": token } : {} });
	}

	it("refuses a notice claiming a bound session when no binding is presented at all", async () => {
		const { ctx, team } = boundCtx();
		const { humanNotify } = createRoutes(ctx);

		const res = humanNotify(reqWith(), { from: team, title: "t", summary: "s", full: "b" });

		expect(res.status).toBe(403);
	});

	it("refuses a notice presenting some other session's binding", async () => {
		const { ctx, team } = boundCtx();
		const other = ctx.sessionStore!.mint({ spawn: "other-app" });
		const otherToken = ctx.sessionStore!.ensureBindToken(other);
		const { humanNotify } = createRoutes(ctx);

		const res = humanNotify(reqWith(otherToken), { from: team, title: "t", summary: "s", full: "b" });

		expect(res.status).toBe(403);
	});

	it("accepts the session that holds the binding", async () => {
		const { ctx, team, token } = boundCtx();
		const { humanNotify } = createRoutes(ctx);

		const res = humanNotify(reqWith(token), { from: team, title: "t", summary: "s", full: "b" });

		expect(res.status).toBe(200);
	});

	it("leaves an unbound name open, so a hand-launched session still speaks for itself", async () => {
		const sessionStore = new SessionStore();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		const mailboxStore = new DeviceMailboxStore();
		mailboxStore.ensure("owner-1");
		const { humanNotify } = createRoutes(makeCtx({ sessionStore, mailboxStore, ownerId: () => "owner-1" }));

		const res = humanNotify(reqWith(), {
			from: sessionStore.teamOf(record),
			title: "t",
			summary: "s",
			full: "b",
		});

		expect(res.status).toBe(200);
	});

	it("refuses a plugin action claiming a bound session without its binding", async () => {
		const { ctx, team } = boundCtx();
		const { pluginAction } = createRoutes(ctx);

		const res = pluginAction(reqWith(), { from: team, pluginId: "designer", actionType: "delete-card" });

		expect(res.status).toBe(403);
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

// The console's `from` is the human's free-form Device Name, not a session name, and its ops are
// already authenticated by the sealed relay before they reach here. Gating it on a name that cannot
// resolve to a record blocks the owner from messaging their own sessions at all.
describe("the console sends under its own device name", () => {
	it("accepts a send whose sender is a device name rather than a local session", async () => {
		const sessionStore = new SessionStore();
		const ws = { readyState: 1, send: vi.fn(), data: { mode: "channel", handshakeConfirmed: true } };
		const registry = makeRegistry({ "recipe-app.abc123": ws });
		const { send } = createRoutes(makeCtx({ registry, sessionStore }));

		const res = await send(
			new Request("http://gateway/send"),
			{ from: "Pixel 10 Pro XL", fromConversationId: "owner-1", to: "recipe-app.abc123", body: "hi" },
			{ consoleSender: true },
		);

		expect(res.status).toBe(200);
	});
});
