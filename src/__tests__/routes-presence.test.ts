import { describe, expect, it } from "vitest";
import { createRoutes, type RoutesDeps } from "../gateway/routes.js";
import { SessionStore } from "../shared/session-store.js";
import { makeCtx, makePresence, makeRegistry } from "./helpers/routes.js";

describe("routes", () => {
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

		it("carries a row's description across, since a friend's older Gateway still sends one", () => {
			// Nothing local writes a description any more, so from a local snapshot alone this conversion
			// looks dead and sweeps cleanly. It is not: pullPresenceFromDomain runs a NOT-YET-UPDATED
			// friend's rows through this same converter, and dropping the line costs their session rows
			// the description subtitle on the owner's console with no gate anywhere to catch it. This
			// drives the converter through its outbound caller, which is the reachable one from a test;
			// what it pins is the field surviving the conversion, not the pull path's own routing.
			const presence = {
				snapshot: () => [
					{
						team: "proj.main",
						gatewayId: "test-host",
						domainId: "alice",
						status: "online" as const,
						kind: "loose" as const,
						description: "wiring the relay",
						queue_depth: 0,
					},
				],
			} as unknown as RoutesDeps["presence"];
			const { presenceForDomain } = createRoutes(
				makeCtx({ presence, sharesFor: () => ["alice.test-host.proj.main"] }),
			);
			expect(presenceForDomain("bob-domain")[0]?.description).toBe("wiring the relay");
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
});
