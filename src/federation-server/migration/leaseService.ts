// Per-gateway migration leases, and the authority switch they gate.
//
// Records live in the owner store for their own Domain, keyed by gateway id. The rules themselves
// are in shared/migration-lease.ts, shared so the gateway and the Router answer them the same way.

import {
	authorityReady,
	fenceOnReconnect,
	type LeaseState,
	type MigrationLease,
} from "../../shared/migration-lease.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";

/** The epoch the fleet is migrating to, from the environment. Zero, and inert, outside a window. */
export function routerMigrationEpoch(): number {
	const raw = Number.parseInt(process.env.ROUTER_MIGRATION_EPOCH ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export interface LeaseDeps {
	registry: OwnerStoreRegistry;
	/** The epoch the fleet is migrating to. Zero outside a migration window. */
	migrationEpoch: () => number;
}

const asLease = (clear: Record<string, unknown>): MigrationLease => ({
	state: clear.state as LeaseState,
	epoch: Number(clear.epoch ?? 0),
	...(clear.completedEpoch === undefined ? {} : { completedEpoch: Number(clear.completedEpoch) }),
});

export function createLeaseService(deps: LeaseDeps) {
	const read = (domainId: string, gatewayId: string): MigrationLease | undefined => {
		const record = deps.registry.for(domainId).get("migration", gatewayId);
		return record ? asLease(record.clear) : undefined;
	};

	const list = (domainId: string): MigrationLease[] =>
		deps.registry
			.for(domainId)
			.list("migration")
			.map((record) => asLease(record.clear));

	return {
		read,
		list,

		/** Records a gateway's state. Completion is stamped separately, by `complete`. */
		put(domainId: string, gatewayId: string, state: LeaseState): void {
			const store = deps.registry.for(domainId);
			const current = store.get("migration", gatewayId);
			const lease = { ...(current?.clear ?? {}), state, epoch: deps.migrationEpoch() };
			store.put("migration", gatewayId, current?.version ?? null, { clear: lease });
		},

		/** Stamps the epoch this gateway has exported AND had imported. */
		complete(domainId: string, gatewayId: string): void {
			const store = deps.registry.for(domainId);
			const current = store.get("migration", gatewayId);
			const lease = { ...(current?.clear ?? { state: "active" }), completedEpoch: deps.migrationEpoch() };
			store.put("migration", gatewayId, current?.version ?? null, { clear: lease });
		},

		/** Whether the Router may take authority for this Domain's owner state. */
		ready(domainId: string): boolean {
			return authorityReady(list(domainId), deps.migrationEpoch());
		},

		/** Whether a reconnecting gateway must be refused its writes. */
		fenced(domainId: string, gatewayId: string): boolean {
			if (deps.migrationEpoch() === 0) return false;
			return fenceOnReconnect(read(domainId, gatewayId), deps.migrationEpoch());
		},
	};
}
