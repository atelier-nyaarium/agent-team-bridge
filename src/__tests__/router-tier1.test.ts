import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayFrameHandler } from "../federation-server/gatewayBridge.js";
import { OwnerOpRefused } from "../federation-server/inbox/ownerOpIntake.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerQuarantined } from "../federation-server/owner/ownerStateStore.js";
import type { ErasedOwnerOpHandler, OwnerOpHandler, OwnerOpKind } from "../federation-server/ownerOpRegistry.js";
import type { OwnerServiceHooks } from "../federation-server/ownerServiceHooks.js";
import { createCapabilitiesService } from "../federation-server/tier1/capabilitiesService.js";
import { createReadAnchorsService } from "../federation-server/tier1/readAnchorsService.js";

const roots: string[] = [];
const make = () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-tier1-"));
	roots.push(dataDir);
	let now = 1000;
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (domainId) => (domainId === "a" ? "owner-a" : domainId === "b" ? "owner-b" : null),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: () => now },
	});
	return { registry, setNow: (value: number) => (now = value) };
};

const makeHooks = () => {
	const ownerOps = new Map<string, ErasedOwnerOpHandler>();
	const gatewayFrames = new Map<string, GatewayFrameHandler>();
	return {
		ownerOps,
		gatewayFrames,
		hooks: {
			ownerOp: <Kind extends OwnerOpKind>(name: Kind, handler: OwnerOpHandler<Kind>) => {
				ownerOps.set(name, handler as ErasedOwnerOpHandler);
			},
			gatewayFrame: (name: string, handler: GatewayFrameHandler) => gatewayFrames.set(name, handler),
			onGatewayRegistered: () => {},
			onGatewayDropped: () => {},
			onSessionForgotten: () => {},
			pushFrameTo: () => false,
			gatewayIncarnation: () => null,
			connectedGateways: () => [],
		} satisfies OwnerServiceHooks,
	};
};

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Router tier 1 services", () => {
	it("returns uncertainty from the capabilities read frame", async () => {
		const { registry } = make();
		const service = createCapabilitiesService({ registry });
		const { hooks, gatewayFrames } = makeHooks();
		service.register(hooks);
		const store = registry.for("a");
		vi.spyOn(store, "list").mockImplementation(() => {
			throw new OwnerQuarantined({ from: 1, to: 1 });
		});
		expect(
			await gatewayFrames.get("capabilities_read")?.({ domainId: "a" } as Parameters<GatewayFrameHandler>[0], {
				kind: "capabilities_read",
			}),
		).toEqual({ outcome: "durability_uncertain" });
		registry.close();
	});
	it("folds capabilities by report time and sweeps idle devices", () => {
		const { registry, setNow } = make();
		const service = createCapabilitiesService({ registry, ttlMs: 10_000 });
		service.report("a", "phone", { capabilities: [{ id: "plug", instructions: "old" }] });
		setNow(2000);
		service.report("a", "tablet", { capabilities: [{ id: "plug", instructions: "new" }] });
		expect(service.snapshot("a").capabilities).toEqual([{ id: "plug", instructions: "new" }]);
		service.sweep("a", 12_001);
		expect(service.snapshot("a")).toMatchObject({ known: false, capabilities: [] });
		registry.close();
	});

	it("touches a device at most once an hour", () => {
		const { registry, setNow } = make();
		const service = createCapabilitiesService({ registry, ttlMs: 10_000 });
		service.report("a", "phone", { capabilities: [{ id: "plug" }] });
		setNow(3_600_999);
		service.touch("a", "phone");
		service.sweep("a", 11_001);
		expect(service.snapshot("a")).toMatchObject({ known: false, capabilities: [] });
		setNow(1000);
		service.report("a", "phone", { capabilities: [{ id: "plug" }] });
		setNow(3_601_000);
		service.touch("a", "phone");
		service.sweep("a", 3_610_999);
		expect(service.snapshot("a").known).toBe(true);
		service.sweep("a", 3_611_001);
		expect(service.snapshot("a")).toMatchObject({ known: false, capabilities: [] });
		registry.close();
	});

	it("keeps capabilities when a report omits them", () => {
		const { registry, setNow } = make();
		const service = createCapabilitiesService({ registry });
		service.report("a", "phone", { capabilities: [{ id: "plug" }], clientVersion: "one" });
		setNow(2000);
		service.report("a", "phone", {});
		expect(service.snapshot("a")).toMatchObject({
			known: true,
			capabilities: [{ id: "plug" }],
			clientVersions: ["one"],
		});
		registry.close();
	});

	it("refuses the 501st capability device", () => {
		const { registry } = make();
		const service = createCapabilitiesService({ registry });
		for (let i = 0; i < 500; i++) service.report("a", `device-${i}`, { capabilities: [] });
		expect(() => service.report("a", "device-500", { capabilities: [] })).toThrow(OwnerOpRefused);
		expect(() => service.report("a", "device-0", { capabilities: [] })).not.toThrow();
		registry.close();
	});

	it("merges anchors monotonically and versions only advances", () => {
		const { registry } = make();
		const service = createReadAnchorsService({ registry });
		expect(service.report("a", "team", { epoch: 1, seq: 10, at: 1 })).toBe(true);
		const first = service.read("a");
		expect(service.report("a", "team", { epoch: 1, seq: 5, at: 2 })).toBe(false);
		expect(service.read("a").version.version).toBe(first.version.version);
		expect(service.report("a", "team", { epoch: 2, seq: 1, at: 3 })).toBe(true);
		expect(service.read("a").anchors).toEqual([{ team: "team", epoch: 2, seq: 1, at: 3 }]);
		registry.close();
	});

	it("stores a team named version without replacing the version record", () => {
		const { registry } = make();
		const service = createReadAnchorsService({ registry });
		const initial = service.read("a");

		expect(service.report("a", "version", { epoch: 1, seq: 1, at: 1 })).toBe(true);

		expect(service.read("a")).toMatchObject({
			version: { epoch: initial.version.epoch, version: initial.version.version + 1 },
			anchors: [{ team: "version", epoch: 1, seq: 1, at: 1 }],
		});
		registry.close();
	});

	it("isolates Domains and caps new anchor teams", () => {
		const { registry } = make();
		const service = createReadAnchorsService({ registry });
		service.report("a", "same", { epoch: 1, seq: 1, at: 1 });
		service.report("b", "same", { epoch: 1, seq: 1, at: 1 });
		expect(service.read("a").anchors).toHaveLength(1);
		expect(service.read("b").anchors).toHaveLength(1);
		for (let i = 0; i < 499; i++) service.report("a", `team-${i}`, { epoch: 1, seq: 1, at: 1 });
		expect(() => service.report("a", "team-500", { epoch: 1, seq: 1, at: 1 })).toThrow(OwnerOpRefused);
		expect(service.report("a", "same", { epoch: 1, seq: 2, at: 2 })).toBe(true);
		registry.close();
	});

	// Cross-epoch merges use receiver time.
	it("stamps the report time itself rather than trusting the reporter", async () => {
		const { registry, setNow } = make();
		const anchors = createReadAnchorsService({ registry });
		const { hooks, ownerOps } = makeHooks();
		anchors.register(hooks);
		const op = { domainId: "a", conversationId: "phone" } as Parameters<ErasedOwnerOpHandler>[0];

		await ownerOps.get("report_read")?.(op, {
			kind: "report_read",
			team: "team",
			epoch: 1,
			seq: 1,
			at: Number.MAX_SAFE_INTEGER,
		});
		setNow(2000);
		const advanced = await ownerOps.get("report_read")?.(op, {
			kind: "report_read",
			team: "team",
			epoch: 2,
			seq: 1,
			at: 1,
		});

		expect(advanced).toMatchObject({ advanced: true });
		registry.close();
	});

	it("registers tier 1 owner operations and gateway frames", async () => {
		const { registry } = make();
		const capabilities = createCapabilitiesService({ registry });
		const anchors = createReadAnchorsService({ registry });
		const { hooks, ownerOps, gatewayFrames } = makeHooks();
		capabilities.register(hooks);
		anchors.register(hooks);
		expect([...ownerOps.keys()]).toEqual([
			"capabilities_report",
			"capabilities_read",
			"report_read",
			"read_anchors_read",
		]);
		expect([...gatewayFrames.keys()]).toEqual(["capabilities_read"]);
		const op = { domainId: "a", conversationId: "phone" } as Parameters<ErasedOwnerOpHandler>[0];
		await ownerOps.get("capabilities_report")?.(op, { kind: "capabilities_report", capabilities: [] });
		await ownerOps.get("report_read")?.(op, { kind: "report_read", team: "team", epoch: 1, seq: 1, at: 1 });
		expect(await ownerOps.get("capabilities_read")?.(op, { kind: "capabilities_read" })).toMatchObject({
			known: true,
		});
		expect(await ownerOps.get("read_anchors_read")?.(op, { kind: "read_anchors_read" })).toMatchObject({
			anchors: [{ team: "team" }],
		});
		expect(
			await gatewayFrames.get("capabilities_read")?.({ domainId: "a" } as Parameters<GatewayFrameHandler>[0], {
				kind: "capabilities_read",
			}),
		).toMatchObject({ known: true });
		registry.close();
	});
	it("returns unapplied tier 1 writes without following effects", async () => {
		const { registry } = make();
		const capabilities = createCapabilitiesService({ registry });
		const anchors = createReadAnchorsService({ registry });
		const { hooks, ownerOps } = makeHooks();
		capabilities.register(hooks);
		anchors.register(hooks);
		vi.spyOn(registry.for("a"), "put").mockReturnValue({ kind: "durability_failure", reason: "full" });
		const op = { domainId: "a", conversationId: "phone" } as Parameters<ErasedOwnerOpHandler>[0];
		expect(
			await ownerOps.get("capabilities_report")?.(op, { kind: "capabilities_report", capabilities: [] }),
		).toEqual({
			outcome: "durability_failure",
		});
		expect(
			await ownerOps.get("report_read")?.(op, { kind: "report_read", team: "team", epoch: 1, seq: 1, at: 1 }),
		).toEqual({
			outcome: "durability_failure",
		});
		expect(registry.for("a").list("capabilities")).toEqual([]);
		expect(registry.for("a").list("readAnchor")).toEqual([]);
		registry.close();
	});
});
