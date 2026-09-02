import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayFrameHandler, GatewayRegistration } from "../federation-server/gatewayBridge.js";
import type { OwnerOpHandler } from "../federation-server/inbox/ownerOpIntake.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { createPresenceService } from "../federation-server/presence/presenceService.js";
import { TeamInfoSchema } from "../shared/schemasPresence.js";

const roots: string[] = [];
const row = (team: string, lastActive = 1, status: "online" | "verifying" | "available" = "online") =>
	TeamInfoSchema.parse({
		team,
		gatewayId: "gw",
		status,
		kind: "devcontainer",
		queue_depth: 1,
		lastActive,
	});
const make = (pokeOwner?: (domainId: string, version: number, projection: unknown) => void) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-presence-"));
	roots.push(dataDir);
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: () => "owner",
		quotaFor: () =>
			new DomainQuota({
				dir: dataDir,
				limitBytes: 10_000_000,
				reserveBytes: 0,
				statfs: () => ({ available: 10_000_000 }),
			}),
		now: () => 100,
	});
	return { registry, service: createPresenceService({ registry, pokeOwner }) };
};
const reg: GatewayRegistration = { domainId: "domain", gatewayId: "gw", signPub: "pub", incarnation: 1 };
const projectionDeps = {
	admittedGateways: () => ["gw"],
	linkedDomains: () => [],
	isShared: () => false,
	connected: () => ["gw"],
};

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("router presence slice", () => {
	it("applies ordered deltas and bumps the persisted projection version", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});
		const before = service.ownerProjection("domain", projectionDeps).plane;
		service.applyDelta(reg, { incarnation: 1, seq: 1, upserts: [row("proj.main", 2)], tombstones: [] });
		expect(service.ownerProjection("domain", projectionDeps).plane.version).toBe(before.version);
		service.applyDelta(reg, {
			incarnation: 1,
			seq: 2,
			upserts: [row("proj.main", 2, "available")],
			tombstones: [],
		});
		expect(service.ownerProjection("domain", projectionDeps).plane.version).toBe(before.version + 1);
		registry.close();
	});

	// This push is what lets the phone drop its bounded-interval discovery pull, so it has to fire on
	// a real change, stay quiet otherwise, and carry the rows rather than a bare version.
	it("pushes the whole projection to the owner only when it actually changed", () => {
		const pokes: Array<{ domainId: string; version: number; teams: number }> = [];
		const { registry, service } = make((domainId, version, projection) =>
			pokes.push({ domainId, version, teams: ((projection as { rows: unknown[] }).rows ?? []).length }),
		);
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});

		service.ownerProjection("domain", projectionDeps);
		expect(pokes).toEqual([{ domainId: "domain", version: 0, teams: 1 }]);
		// Same projection read twice: no change, so no second poke.
		service.ownerProjection("domain", projectionDeps);
		expect(pokes).toHaveLength(1);

		service.applyDelta(reg, {
			incarnation: 1,
			seq: 1,
			upserts: [row("proj.main", 2, "available")],
			tombstones: [],
		});
		service.ownerProjection("domain", projectionDeps);
		expect(pokes).toEqual([
			{ domainId: "domain", version: 0, teams: 1 },
			{ domainId: "domain", version: 1, teams: 1 },
		]);
		registry.close();
	});

	it("resyncs gaps and foreign incarnations without changing rows", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});
		expect(
			service.applyDelta(reg, { incarnation: 1, seq: 3, upserts: [row("other.main")], tombstones: [] }),
		).toEqual({ resync: true });
		expect(
			service.applyDelta(reg, { incarnation: 2, seq: 1, upserts: [row("other.main")], tombstones: [] }),
		).toEqual({ resync: true });
		expect(service.ownerProjection("domain", projectionDeps).rows.map((r) => r.team)).toEqual(["proj.main"]);
		registry.close();
	});

	it("keeps dropped rows as unreachable and replaces them on a new baseline", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main"), row("other.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});
		service.onGatewayDropped(reg);
		expect(registry.for("domain").get("presence.row", "presence.row:gw/proj.main")?.clear.presenceFresh).toBe(
			"unreachable",
		);
		expect(registry.for("domain").get("presence.row", "presence.row:gw/other.main")?.clear.presenceFresh).toBe(
			"unreachable",
		);
		expect(service.ownerProjection("domain", projectionDeps).spawnPoints).toEqual([
			{ gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		]);
		service.applyBaseline(
			{ ...reg, incarnation: 2 },
			{
				incarnation: 2,
				seq: 0,
				rows: [row("new.main")],
				spawnPoints: { gatewayId: "gw", hostSpawns: ["shell"] },
			},
		);
		expect(registry.for("domain").get("presence.row", "presence.row:gw/proj.main")).toBeNull();
		registry.close();
	});

	it("resyncs a delta after re-registration until a new baseline", () => {
		const { registry, service } = make();
		const frames = new Map<string, GatewayFrameHandler>();
		const registered: ((registration: GatewayRegistration) => void)[] = [];
		const pushed: Record<string, unknown>[] = [];
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: (name, handler) => frames.set(name, handler),
			onGatewayRegistered: (listener) => registered.push(listener),
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: (_domainId, _gatewayId, frame) => {
				pushed.push(frame);
				return true;
			},
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
		});
		frames.get("presence_baseline")!(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});
		registered[0](reg);

		expect(frames.get("presence_delta")!(reg, { incarnation: 1, seq: 1, upserts: [], tombstones: [] })).toEqual({
			resync: true,
		});
		expect(pushed).toEqual([{ type: "presence_resync", incarnation: 1 }]);
		registry.close();
	});

	it("stamps the registration identity on payload rows and spawn points", () => {
		const { registry, service } = make();
		const registration = { ...reg, gatewayId: "sender", domainId: "owned" };
		service.applyBaseline(registration, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "payload", domainId: "payload", hostSpawns: ["shell"] },
		});
		const projection = service.ownerProjection("owned", {
			...projectionDeps,
			admittedGateways: () => ["sender"],
		});

		expect(projection.rows).toMatchObject([{ team: "proj.main", gatewayId: "sender", domainId: "owned" }]);
		expect(projection.spawnPoints).toEqual([{ gatewayId: "sender", domainId: "owned", hostSpawns: ["shell"] }]);
		registry.close();
	});

	it("rearms every row as unreachable", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});
		service.rearm("domain");

		expect(service.ownerProjection("domain", projectionDeps).rows).toMatchObject([
			{ team: "proj.main", presenceFresh: "unreachable" },
		]);
		registry.close();
	});

	it("forgets a session through the registered hook", () => {
		const { registry, service } = make();
		let forget: ((registration: GatewayRegistration, sessionId: string) => void) | undefined;
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: () => undefined,
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: (listener) => {
				forget = listener;
			},
			pushFrameTo: () => true,
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
		});
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});
		forget?.(reg, "proj.main");

		expect(service.ownerProjection("domain", projectionDeps).rows).toEqual([]);
		registry.close();
	});

	it("touches live rows and not available rows", () => {
		const { registry } = make();
		const touched: string[] = [];
		const service = createPresenceService({ registry, touch: (_domainId, target) => touched.push(target) });
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("online.main"), row("available.main", 1, "available")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});

		expect(touched).toEqual(["domain.gw.online.main"]);
		registry.close();
	});

	it("keeps a gateway named gateway isolated from other gateway records", () => {
		const { registry, service } = make();
		const gateway = { ...reg, gatewayId: "gateway" };
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("gw.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: ["gw-shell"] },
		});
		service.applyBaseline(gateway, {
			incarnation: 1,
			seq: 0,
			rows: [row("gateway.main")],
			spawnPoints: { gatewayId: "gateway", hostSpawns: ["gateway-shell"] },
		});
		service.applyBaseline(
			{ ...reg, incarnation: 2 },
			{
				incarnation: 2,
				seq: 0,
				rows: [row("gw.new")],
				spawnPoints: { gatewayId: "gw", hostSpawns: ["gw-new-shell"] },
			},
		);

		expect(
			service.ownerProjection("domain", { ...projectionDeps, admittedGateways: () => ["gw", "gateway"] }),
		).toMatchObject({
			rows: [{ team: "gateway.main" }, { team: "gw.new" }],
			spawnPoints: [{ gatewayId: "gw" }, { gatewayId: "gateway" }],
		});
		registry.close();
	});

	it("filters friend presence and derives roster coverage", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});
		const projection = service.friendProjection("domain", "friend", {
			isShared: (_d, target) => target.includes("proj.main"),
		});
		expect(Object.keys(projection.sessions[0])).toEqual([
			"team",
			"gatewayId",
			"status",
			"kind",
			"sessionLabel",
			"description",
			"lastActive",
			"queueDepth",
			"working",
			"needsLogin",
		]);
		expect(service.roster("domain", ["gw", "offline"], ["gw"]).coverage).toMatchObject({
			rosterKnown: true,
			asked: 2,
			answered: 1,
			unreachable: ["offline"],
		});
		registry.close();
	});

	it("routes gateway frames and pushes resync for a gap", () => {
		const { registry, service } = make();
		const frames = new Map<string, GatewayFrameHandler>();
		const pushed: Record<string, unknown>[] = [];
		const hooks = {
			ownerOp: () => undefined,
			gatewayFrame: (name: string, handler: GatewayFrameHandler) => frames.set(name, handler),
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: (_domainId: string, _gatewayId: string, frame: Record<string, unknown>) => {
				pushed.push(frame);
				return true;
			},
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
		};
		service.register(hooks);
		frames.get("presence_baseline")!(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", hostSpawns: [] },
		});
		frames.get("presence_delta")!(reg, { incarnation: 1, seq: 2, upserts: [], tombstones: [] });
		expect(pushed).toEqual([{ type: "presence_resync", incarnation: 1 }]);
		registry.close();
	});

	it("answers linked friend reads, refuses unlinked reads, and isolates Domains", () => {
		const { registry } = make();
		const service = createPresenceService({
			registry,
			projection: {
				admittedGateways: (domainId) => (domainId === "a" ? ["gw"] : []),
				linkedDomains: (domainId) => (domainId === "a" ? ["b"] : []),
				isShared: (domainId, target, toDomainId) =>
					domainId === "b" && target.includes("b.main") && toDomainId === "a",
				connected: (domainId) => (domainId === "a" ? ["gw"] : []),
			},
			friend: { isShared: (_domainId, target, toDomainId) => target.includes("b.main") && toDomainId === "a" },
		});
		service.applyBaseline(
			{ ...reg, domainId: "a" },
			{
				incarnation: 1,
				seq: 0,
				rows: [row("a.main")],
				spawnPoints: { gatewayId: "gw", hostSpawns: [] },
			},
		);
		service.applyBaseline(
			{ ...reg, domainId: "b" },
			{
				incarnation: 1,
				seq: 0,
				rows: [row("b.main")],
				spawnPoints: { gatewayId: "gw", hostSpawns: [] },
			},
		);
		const handlers = new Map<string, OwnerOpHandler>();
		service.register({
			ownerOp: (kind, handler) => handlers.set(kind, handler),
			gatewayFrame: () => undefined,
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: () => true,
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
		});
		const op = { domainId: "a" } as Parameters<OwnerOpHandler>[0];
		expect(handlers.get("presence_read_friend")!(op, { toDomainId: "c" })).toEqual({
			outcome: "refused",
			reason: "not linked",
		});
		expect(handlers.get("presence_read_friend")!(op, { toDomainId: "b" })).toMatchObject({
			sessions: [{ team: "b.main" }],
		});
		expect(
			service
				.ownerProjection("a", {
					admittedGateways: () => ["gw"],
					linkedDomains: () => [],
					isShared: () => false,
					connected: () => ["gw"],
				})
				.rows.map((r) => r.team),
		).toEqual(["a.main"]);
		registry.close();
	});
});
