import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayFrameHandler, GatewayRegistration } from "../federation-server/gatewayBridge.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import {
	type ErasedOwnerOpHandler,
	type OwnerOpHandler,
	type OwnerOpKind,
	type OwnerOpMutation,
	ownerOpEntry,
} from "../federation-server/ownerOpRegistry.js";
import { createShareService, type ShareServiceDeps } from "../federation-server/share/shareService.js";
import { generateIdentity } from "../shared/crypto.js";

const roots: string[] = [];
const make = () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-share-"));
	roots.push(dataDir);
	const owners = new Map([
		["a", generateIdentity().sign.pub],
		["b", generateIdentity().sign.pub],
	]);
	let now = 100;
	const links = new Set<string>();
	const edgeIds = new Map<string, string>();
	const retired: string[][] = [];
	const pushed: Array<{ domainId: string; gatewayId: string; frame: Record<string, unknown> }> = [];
	const ownerOps = new Map<string, ErasedOwnerOpHandler>();
	const gatewayFrames = new Map<string, GatewayFrameHandler>();
	const classes = new Map<string, string>();
	let gatewayDropped: ((reg: GatewayRegistration) => void) | undefined;
	const gateways = new Map([
		["a", ["a-gateway"]],
		["b", ["b-gateway"]],
	]);
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (domainId) => owners.get(domainId) ?? null,
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: () => now },
	});
	const deps: ShareServiceDeps = {
		registry,
		isLinked: (domainId, friendDomainId) => links.has(`${domainId}|${friendDomainId}`),
		linkEdgeId: (domainId, friendDomainId) =>
			links.has(`${domainId}|${friendDomainId}`)
				? (edgeIds.get(`${domainId}|${friendDomainId}`) ?? "edge-1")
				: null,
		dropLinkEdge: (domainId, friendDomainId) => links.delete(`${domainId}|${friendDomainId}`),
		retireRevokedPeerRows: (domainId, sessionTarget, friendDomainId) =>
			retired.push([domainId, sessionTarget, friendDomainId]),
		connectedGateways: (domainId) => gateways.get(domainId) ?? [],
		now: () => now,
	};
	return {
		service: createShareService(deps),
		registry,
		ownerOps,
		gatewayFrames,
		classes,
		links,
		edgeIds,
		retired,
		pushed,
		dropGateway: (reg: GatewayRegistration) => gatewayDropped?.(reg),
		setNow: (value: number) => (now = value),
		hooks: {
			ownerOp: <Kind extends OwnerOpKind>(kind: Kind, handler: OwnerOpHandler<Kind>) => {
				ownerOps.set(kind, handler as ErasedOwnerOpHandler);
			},
			gatewayFrame: (name: string, mutation: OwnerOpMutation, handler: GatewayFrameHandler) => {
				classes.set(name, mutation);
				gatewayFrames.set(name, handler);
			},
			onGatewayRegistered: () => undefined,
			onGatewayDropped: (listener: (reg: GatewayRegistration) => void) => {
				gatewayDropped = listener;
			},
			onSessionForgotten: () => undefined,
			pushFrameTo: (domainId: string, gatewayId: string, frame: Record<string, unknown>) => {
				pushed.push({ domainId, gatewayId, frame });
				return true;
			},
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
		},
	};
};

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ShareService", () => {
	it("requires a live link for specific and everyone-trusted shares", () => {
		const ctx = make();
		ctx.service.share("a", "a.gw.spawn.main", { kind: "domain", domainId: "b" });
		ctx.service.share("a", "a.gw.spawn.other", { kind: "everyone_trusted" });
		expect(ctx.service.isSharedTo("a", "a.gw.spawn.main", "b")).toBe(false);
		ctx.links.add("a|b");
		ctx.edgeIds.set("a|b", "edge-1");
		expect(ctx.service.isSharedTo("a", "a.gw.spawn.main", "b")).toBe(true);
		expect(ctx.service.isSharedTo("a", "a.gw.spawn.other", "b")).toBe(true);
		ctx.registry.close();
	});

	it("unsharing bumps generation and retires the pair once", () => {
		const ctx = make();
		ctx.links.add("a|b");
		ctx.edgeIds.set("a|b", "edge-1");
		ctx.service.share("a", "a.gw.spawn.main", { kind: "domain", domainId: "b" });
		const before = ctx.service.generation("a", "a.gw.spawn.main", "b");
		expect(ctx.service.unshare("a", "a.gw.spawn.main", { kind: "domain", domainId: "b" })).toEqual({ ok: true });
		expect(ctx.service.generation("a", "a.gw.spawn.main", "b")).toBe(before + 1);
		expect(ctx.retired).toEqual([["a", "a.gw.spawn.main", "b"]]);
		ctx.service.share("a", "a.gw.spawn.main", { kind: "domain", domainId: "b" });
		expect(ctx.service.admitPeerRow("a", "a.gw.spawn.main", "b")).toBeGreaterThan(before);
		expect(ctx.service.generation("a", "a.gw.spawn.main", "b")).toBe(before + 1);
		ctx.registry.close();
	});

	it("admits only a shared linked pair and isolates Domains", () => {
		const ctx = make();
		ctx.links.add("a|b");
		ctx.service.share("a", "a.gw.spawn.main", { kind: "domain", domainId: "b" });
		expect(ctx.service.admitPeerRow("a", "a.gw.spawn.main", "b")).toBe(0);
		expect(ctx.service.admitPeerRow("a", "a.gw.spawn.main", "c")).toBeNull();
		expect(ctx.service.listShares("b")).toEqual({ shares: [] });
		ctx.registry.close();
	});

	it("keeps attested shares, refreshes touched shares, and handles incarnations", () => {
		const ctx = make();
		ctx.links.add("a|b");
		ctx.service.share("a", "a.g.spawn.live", { kind: "domain", domainId: "b" });
		ctx.service.share("a", "a.g.spawn.idle", { kind: "domain", domainId: "b" });
		ctx.service.share("a", "a.g.spawn.touched", { kind: "domain", domainId: "b" });
		ctx.service.share("a", "a.g.spawn.old", { kind: "domain", domainId: "b" });
		ctx.service.share("a", "a.g.spawn.new", { kind: "domain", domainId: "b" });
		ctx.setNow(100 + 30 * 24 * 60 * 60 * 1000);
		ctx.service.touch("a", "a.g.spawn.touched");
		expect(ctx.service.sweep("a")).toBe(0);
		ctx.service.attest(
			{ domainId: "a", gatewayId: "g", signPub: "p", incarnation: 2 },
			{
				sessionTarget: "a.g.spawn.live",
				jobIds: ["job"],
				observedAt: 100,
				incarnation: 2,
			},
		);
		ctx.service.attest(
			{ domainId: "a", gatewayId: "g", signPub: "p", incarnation: 1 },
			{
				sessionTarget: "a.g.spawn.old",
				jobIds: ["job"],
				observedAt: 100,
				incarnation: 1,
			},
		);
		ctx.service.attest(
			{ domainId: "a", gatewayId: "g", signPub: "p", incarnation: 2 },
			{
				sessionTarget: "a.g.spawn.new",
				jobIds: ["job"],
				observedAt: 100,
				incarnation: 2,
			},
		);
		ctx.service.attest(
			{ domainId: "a", gatewayId: "g", signPub: "p", incarnation: 2 },
			{
				sessionTarget: "a.g.spawn.live",
				jobIds: [],
				observedAt: 100,
				incarnation: 2,
			},
		);
		ctx.setNow(100 + 30 * 24 * 60 * 60 * 1000 + 1);
		expect(ctx.service.sweep("a")).toBe(3);
		expect(ctx.service.isSharedTo("a", "a.g.spawn.live", "b")).toBe(false);
		expect(ctx.service.isSharedTo("a", "a.g.spawn.new", "b")).toBe(true);
		expect(ctx.service.isSharedTo("a", "a.g.spawn.old", "b")).toBe(false);
		expect(ctx.service.isSharedTo("a", "a.g.spawn.idle", "b")).toBe(false);
		expect(ctx.service.isSharedTo("a", "a.g.spawn.touched", "b")).toBe(true);
		ctx.registry.close();
	});

	it("stops honouring an attestation from a gateway that went quiet", () => {
		const ctx = make();
		ctx.links.add("a|b");
		ctx.service.share("a", "a.g.spawn.gone", { kind: "domain", domainId: "b" });
		ctx.service.attest(
			{ domainId: "a", gatewayId: "g", signPub: "p", incarnation: 1 },
			{ sessionTarget: "a.g.spawn.gone", jobIds: ["job"], observedAt: 100, incarnation: 1 },
		);

		ctx.setNow(100 + 30 * 24 * 60 * 60 * 1000 + 1);
		expect(ctx.service.sweep("a")).toBe(1);
		expect(ctx.service.isSharedTo("a", "a.g.spawn.gone", "b")).toBe(false);
		ctx.registry.close();
	});

	it("touches, unlinks, retires, and pushes to both Domains", () => {
		const ctx = make();
		ctx.links.add("a|b");
		ctx.links.add("b|a");
		ctx.service.share("a", "a.g.spawn.main", { kind: "domain", domainId: "b" });
		ctx.service.share("a", "a.g.spawn.trusted", { kind: "everyone_trusted" });
		ctx.setNow(200);
		ctx.service.touch("a", "a.g.spawn.main");
		ctx.service.register(ctx.hooks);
		const result = ctx.service.unlink("a", "b");
		expect(result).toEqual({ peersRemoved: 1, sharesDropped: 1, jobsExpired: 0 });
		expect(ctx.retired).toEqual([
			["a", "a.g.spawn.main", "b"],
			["a", "a.g.spawn.trusted", "b"],
		]);
		expect(ctx.service.generation("a", "a.g.spawn.main", "b")).toBe(1);
		expect(ctx.service.generation("a", "a.g.spawn.trusted", "b")).toBe(1);
		expect(ctx.service.isSharedTo("a", "a.g.spawn.main", "b")).toBe(false);
		expect(ctx.service.isSharedTo("a", "a.g.spawn.trusted", "b")).toBe(false);
		expect(ctx.pushed).toContainEqual({
			domainId: "a",
			gatewayId: "a-gateway",
			frame: { type: "unlink", domainId: "b" },
		});
		expect(ctx.pushed).toContainEqual({
			domainId: "b",
			gatewayId: "b-gateway",
			frame: { type: "unlink", domainId: "a" },
		});
		ctx.registry.close();
	});

	it("returns false for an absent unshare without changing state", () => {
		const ctx = make();
		const target = { kind: "domain" as const, domainId: "b" };
		expect(ctx.service.unshare("a", "a.gw.spawn.missing", target)).toEqual({ ok: false });
		expect(ctx.service.listShares("a")).toEqual({ shares: [] });
		expect(ctx.service.generation("a", "a.gw.spawn.missing", "b")).toBe(0);
		expect(ctx.retired).toEqual([]);
		ctx.registry.close();
	});

	it("keeps generation when another record still shares the pair", () => {
		const ctx = make();
		ctx.links.add("a|b");
		const sessionTarget = "a.gw.spawn.main";
		ctx.service.share("a", sessionTarget, { kind: "domain", domainId: "b" });
		ctx.service.share("a", sessionTarget, { kind: "everyone_trusted" });
		expect(ctx.service.unshare("a", sessionTarget, { kind: "domain", domainId: "b" })).toEqual({ ok: true });
		expect(ctx.service.generation("a", sessionTarget, "b")).toBe(0);
		expect(ctx.retired).toEqual([]);
		expect(ctx.service.isSharedTo("a", sessionTarget, "b")).toBe(true);
		ctx.registry.close();
	});

	it("drops an unlinked Domain without notifying either side", () => {
		const ctx = make();
		ctx.service.share("a", "a.gw.spawn.main", { kind: "domain", domainId: "b" });
		ctx.service.register(ctx.hooks);
		expect(ctx.service.unlink("a", "b")).toEqual({ peersRemoved: 0, sharesDropped: 1, jobsExpired: 0 });
		expect(ctx.pushed).toEqual([]);
		expect(ctx.links.has("a|b")).toBe(false);
		ctx.registry.close();
	});

	it("allows everyone-trusted sharing after an unlinked Domain establishes a link", () => {
		const ctx = make();
		ctx.service.unlink("a", "b");
		ctx.links.add("a|b");
		ctx.service.share("a", "a.gw.spawn.main", { kind: "everyone_trusted" });
		expect(ctx.service.isSharedTo("a", "a.gw.spawn.main", "b")).toBe(true);
		ctx.registry.close();
	});

	it("allows everyone-trusted sharing after a fresh link replaces an unlinked edge", () => {
		const ctx = make();
		ctx.links.add("a|b");
		ctx.edgeIds.set("a|b", "edge-1");
		ctx.service.share("a", "a.gw.spawn.main", { kind: "everyone_trusted" });
		ctx.service.unlink("a", "b");
		expect(ctx.service.isSharedTo("a", "a.gw.spawn.main", "b")).toBe(false);
		ctx.links.add("a|b");
		ctx.edgeIds.set("a|b", "edge-1");
		expect(ctx.service.isSharedTo("a", "a.gw.spawn.main", "b")).toBe(false);
		ctx.edgeIds.set("a|b", "edge-2");
		expect(ctx.service.isSharedTo("a", "a.gw.spawn.main", "b")).toBe(true);
		ctx.registry.close();
	});

	it("does not apply unlink effects after a failed batch", () => {
		const ctx = make();
		ctx.links.add("a|b");
		ctx.service.share("a", "a.gw.spawn.main", { kind: "domain", domainId: "b" });
		ctx.service.register(ctx.hooks);
		vi.spyOn(ctx.registry.for("a"), "batch").mockReturnValue({ kind: "durability_failure", reason: "test" });
		expect(ctx.service.unlink("a", "b")).toMatchObject({ outcome: "durability_failure" });
		expect(ctx.links.has("a|b")).toBe(true);
		expect(ctx.pushed).toEqual([]);
		ctx.registry.close();
	});

	it("accepts canonical OwnerOp targets and rejects separators", () => {
		const ctx = make();
		ctx.service.register(ctx.hooks);
		const op = { domainId: "a" } as Parameters<ErasedOwnerOpHandler>[0];
		const share = ctx.ownerOps.get("cross_domain_share")!;
		const value = ownerOpEntry("cross_domain_share")!.value;
		const target = { kind: "domain", domainId: "b" };
		share(op, value.parse({ kind: "cross_domain_share", sessionTarget: "a.gw.spawn.main", target }));
		expect(value.safeParse({ kind: "cross_domain_share", sessionTarget: "a|gw.spawn.main", target }).success).toBe(
			false,
		);
		expect(value.safeParse({ kind: "cross_domain_share", sessionTarget: "a/gw/spawn/main", target }).success).toBe(
			false,
		);
		expect(ctx.service.listShares("a").shares).toHaveLength(1);
		ctx.registry.close();
	});

	it("shares and unshares from a gateway frame, for that gateway's own sessions only", () => {
		const ctx = make();
		ctx.links.add("a|b");
		ctx.service.register(ctx.hooks);
		const reg: GatewayRegistration = { domainId: "a", gatewayId: "gw", signPub: "p", incarnation: 1 };
		const target = { kind: "domain" as const, domainId: "b" };
		const share = ctx.gatewayFrames.get("cross_domain_share")!;
		const unshare = ctx.gatewayFrames.get("cross_domain_unshare")!;
		expect(share(reg, { sessionTarget: "a.gw.spawn.main", target })).toEqual({ ok: true });
		expect(ctx.service.isSharedTo("a", "a.gw.spawn.main", "b")).toBe(true);
		expect(() => share(reg, { sessionTarget: "a.other.spawn.main", target })).toThrow(/session/);
		expect(() => share(reg, { sessionTarget: "z.gw.spawn.main", target })).toThrow(/session/);
		expect(() => share(reg, { sessionTarget: "a.gw.spawn.main" })).toThrow();
		expect(unshare(reg, { sessionTarget: "a.gw.spawn.main", target })).toEqual({ ok: true });
		expect(ctx.service.isSharedTo("a", "a.gw.spawn.main", "b")).toBe(false);
		expect(() => unshare(reg, { sessionTarget: "a.other.spawn.main", target })).toThrow(/session/);
		ctx.registry.close();
	});

	it("ignores foreign attestations and clears attestations on gateway drop", () => {
		const ctx = make();
		ctx.service.share("a", "a.gw.spawn.main", { kind: "domain", domainId: "b" });
		ctx.service.share("a", "a.gw.spawn.foreign", { kind: "domain", domainId: "b" });
		ctx.service.register(ctx.hooks);
		const reg = { domainId: "a", gatewayId: "g", signPub: "p", incarnation: 1 };
		ctx.service.attest(reg, {
			sessionTarget: "x.gw.spawn.foreign",
			jobIds: ["job"],
			observedAt: 100,
			incarnation: 1,
		});
		ctx.service.attest(reg, {
			sessionTarget: "a.other.spawn.foreign",
			jobIds: ["job"],
			observedAt: 100,
			incarnation: 1,
		});
		ctx.service.attest(reg, {
			sessionTarget: "a.gw.spawn.foreign",
			jobIds: ["job"],
			observedAt: 100,
			incarnation: 1,
		});
		ctx.dropGateway(reg);
		ctx.setNow(100 + 30 * 24 * 60 * 60 * 1000 + 1);
		expect(ctx.service.sweep("a")).toBe(2);
		ctx.registry.close();
	});

	it("registers OwnerOp and gateway frame routes", () => {
		const ctx = make();
		ctx.links.add("a|b");
		ctx.service.register(ctx.hooks);
		expect([...ctx.ownerOps.keys()]).toEqual([
			"cross_domain_share",
			"cross_domain_unshare",
			"cross_domain_unlink",
			"cross_domain_list_shares",
		]);
		expect([...ctx.gatewayFrames.keys()]).toEqual(["share_job_live", "cross_domain_share", "cross_domain_unshare"]);
		expect([...ctx.classes]).toEqual([
			["share_job_live", "read"],
			["cross_domain_share", "value"],
			["cross_domain_unshare", "value"],
		]);
		const op = { domainId: "a" } as Parameters<ErasedOwnerOpHandler>[0];
		const target = { kind: "domain" as const, domainId: "b" };

		expect(ctx.ownerOps.get("cross_domain_share")!(op, { sessionTarget: "a.g.spawn.main", target })).toEqual({
			ok: true,
		});
		expect(ctx.ownerOps.get("cross_domain_list_shares")!(op, {})).toEqual({
			shares: [{ sessionTarget: "a.g.spawn.main", target }],
		});
		expect(ctx.ownerOps.get("cross_domain_unshare")!(op, { sessionTarget: "a.g.spawn.main", target })).toEqual({
			ok: true,
		});
		expect(ctx.ownerOps.get("cross_domain_unlink")!(op, { domainId: "b" })).toEqual({
			peersRemoved: 1,
			sharesDropped: 0,
			jobsExpired: 0,
		});

		const reg: GatewayRegistration = { domainId: "a", gatewayId: "g", signPub: "p", incarnation: 1 };
		expect(ctx.gatewayFrames.get("cross_domain_share")!(reg, { sessionTarget: "a.g.spawn.main", target })).toEqual({
			ok: true,
		});
		expect(
			ctx.gatewayFrames.get("cross_domain_unshare")!(reg, { sessionTarget: "a.g.spawn.main", target }),
		).toEqual({ ok: true });
		ctx.gatewayFrames.get("share_job_live")!(reg, {
			sessionTarget: "a.g.spawn.main",
			jobIds: ["job"],
			observedAt: 100,
			incarnation: 1,
		});
		ctx.registry.close();
	});
});
