import type { CapabilitySnapshot } from "../../shared/capabilities.js";
import { admit, type CapabilityFoldRecord, foldCapabilitySnapshot } from "../../shared/capability-fold.js";
import { CapabilitiesReadSchema } from "../../shared/schemasTier1.js";
import { foldWriteResult } from "../../shared/write-result.js";
import { OwnerOpRefused } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { StateRecord } from "../owner/ownerStateStore.js";
import { OwnerQuarantined } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

const DEVICE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const LIVENESS_WRITE_MS = 60 * 60 * 1000;
const MAX_DEVICES = 500;

export interface CapabilitiesServiceDeps {
	registry: OwnerStoreRegistry;
	ttlMs?: number;
}

const write = (result: Parameters<typeof foldWriteResult>[0]) => foldWriteResult(result);

const deviceId = (conversationId: string): string => `capabilities:${conversationId}`;

export function createCapabilitiesService(deps: CapabilitiesServiceDeps) {
	const ttlMs = deps.ttlMs ?? DEVICE_TTL_MS;

	const report = (
		domainId: string,
		conversationId: string,
		value: { capabilities?: unknown[]; clientVersion?: string },
	): ReturnType<typeof write> => {
		const store = deps.registry.for(domainId);
		const id = deviceId(conversationId);
		const current = store.get("capabilities", id);
		if (!current && store.list("capabilities").length >= MAX_DEVICES)
			throw new OwnerOpRefused("capability device limit");
		const now = deps.registry.now();
		const capabilities =
			value.capabilities === undefined ? (current?.clear.capabilities ?? []) : value.capabilities.flatMap(admit);
		const clear = {
			capabilities,
			reportedAt: value.capabilities === undefined ? Number(current?.clear.reportedAt ?? now) : now,
			lastSeen: now,
			...(value.clientVersion === undefined
				? current?.clear.clientVersion
					? { clientVersion: current.clear.clientVersion }
					: {}
				: { clientVersion: value.clientVersion }),
		};
		return write(store.put("capabilities", id, current?.version ?? null, { clear }));
	};

	const touch = (domainId: string, conversationId: string): void => {
		const store = deps.registry.for(domainId);
		const current = store.get("capabilities", deviceId(conversationId));
		if (!current) return;
		const now = deps.registry.now();
		if (now - Number(current.clear.lastSeen) < LIVENESS_WRITE_MS) return;
		write(store.put("capabilities", current.id, current.version, { clear: { ...current.clear, lastSeen: now } }));
	};

	const forget = (domainId: string, conversationId: string): void => {
		const store = deps.registry.for(domainId);
		const current = store.get("capabilities", deviceId(conversationId));
		if (current) foldWriteResult(store.del("capabilities", current.id, current.version));
	};

	const snapshot = (domainId: string): CapabilitySnapshot => {
		const now = deps.registry.now();
		const records: CapabilityFoldRecord[] = deps.registry
			.for(domainId)
			.list("capabilities")
			.map((record: StateRecord) => ({
				capabilities: record.clear.capabilities as CapabilityFoldRecord["capabilities"],
				lastSeen: Number(record.clear.lastSeen),
				reportedAt: Number(record.clear.reportedAt),
				...(typeof record.clear.clientVersion === "string"
					? { clientVersion: record.clear.clientVersion }
					: {}),
			}));
		return foldCapabilitySnapshot(records, now, ttlMs);
	};

	const sweep = (domainId: string, now = deps.registry.now()): void => {
		const store = deps.registry.for(domainId);
		for (const record of store.list("capabilities"))
			if (now - Number(record.clear.lastSeen) > ttlMs)
				foldWriteResult(store.del("capabilities", record.id, record.version));
	};

	return {
		report,
		touch,
		forget,
		snapshot,
		sweep,
		register(hooks: OwnerServiceHooks): void {
			hooks.ownerOp("capabilities_report", async (op, value) => {
				const result = report(op.domainId, op.conversationId, value);
				if (!result.applied) return { outcome: result.outcome };
				return { ...snapshot(op.domainId), outcome: result.outcome };
			});
			hooks.ownerOp("capabilities_read", async (op) => snapshot(op.domainId));
			hooks.gatewayFrame("capabilities_read", async (reg, value) => {
				if (!CapabilitiesReadSchema.safeParse(value).success) throw new OwnerOpRefused("malformed");
				try {
					return snapshot(reg.domainId);
				} catch (error) {
					if (error instanceof OwnerQuarantined) return { outcome: "durability_uncertain" as const };
					throw error;
				}
			});
		},
	};
}
