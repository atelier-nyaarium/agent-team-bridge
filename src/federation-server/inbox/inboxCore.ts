import { formatInboxAddress, type InboxAddress, type OpKey } from "../../shared/schemasInbox.js";
import { OwnerQuarantined, type OwnerStateStore } from "../owner/ownerStateStore.js";
import type { OwnerStoreRegistry } from "./ownerStoreRegistry.js";

/** Runs a read guarded against a quarantined owner store. */
export function guarded<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof OwnerQuarantined) return fallback;
		throw error;
	}
}

export function recordId(key: OpKey, owner: string): string {
	return `op:${owner}/${key.conversationId}/${key.opId}`;
}

export function durabilityOutcome(kind: string): "durability_uncertain" | "durability_failure" {
	return kind === "quarantined" || kind === "durability_uncertain" ? "durability_uncertain" : "durability_failure";
}

export function ledgerTransaction(
	store: OwnerStateStore,
	fn: Parameters<OwnerStateStore["batch"]>[0],
): ReturnType<OwnerStateStore["batch"]> {
	return store.batch(fn);
}

export function ownerAddress(registry: OwnerStoreRegistry, domainId: string): InboxAddress {
	return { kind: "owner", domainId, ownerSignPub: registry.ownerKey(domainId).ownerSignPub };
}

/** Below floor means dropped. */
export function floorOf(store: OwnerStateStore, registry: OwnerStoreRegistry, domainId: string): number {
	return Number(store.get("inbox.address", formatInboxAddress(ownerAddress(registry, domainId)))?.clear.floor ?? 1);
}
