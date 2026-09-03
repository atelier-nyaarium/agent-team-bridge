import fs from "node:fs";
import path from "node:path";
import {
	authorityReady,
	fenceOnReconnect,
	type LeaseState,
	type MigrationLease,
} from "../../shared/migration-lease.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";

/** Zero disables migration. NaN is malformed. */
export function routerMigrationEpoch(): number {
	const file = path.join(process.env.DATA_DIR || "/app/data", "migration-epoch");
	if (fs.existsSync(file)) {
		try {
			const raw = fs.readFileSync(file, "utf8").trim();
			if (!/^[1-9][0-9]*$/.test(raw)) return Number.NaN;
			const epoch = Number(raw);
			return Number.isSafeInteger(epoch) ? epoch : Number.NaN;
		} catch {
			return Number.NaN;
		}
	}
	const raw = process.env.ROUTER_MIGRATION_EPOCH ?? "";
	if (!/^[1-9][0-9]*$/.test(raw)) return 0;
	const epoch = Number(raw);
	return Number.isSafeInteger(epoch) ? epoch : 0;
}

export interface LeaseDeps {
	registry: OwnerStoreRegistry;
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

		/** Records gateway state. */
		put(domainId: string, gatewayId: string, state: LeaseState): void {
			const store = deps.registry.for(domainId);
			const current = store.get("migration", gatewayId);
			const lease = { ...(current?.clear ?? {}), state, epoch: deps.migrationEpoch() };
			store.put("migration", gatewayId, current?.version ?? null, { clear: lease });
		},

		/** Stamps completed migration. */
		complete(domainId: string, gatewayId: string): void {
			const store = deps.registry.for(domainId);
			const current = store.get("migration", gatewayId);
			const lease = { ...(current?.clear ?? { state: "active" }), completedEpoch: deps.migrationEpoch() };
			store.put("migration", gatewayId, current?.version ?? null, { clear: lease });
		},

		ready(domainId: string): boolean {
			const epoch = deps.migrationEpoch();
			return Number.isFinite(epoch) && authorityReady(list(domainId), epoch);
		},

		fenced(domainId: string, gatewayId: string): boolean {
			const epoch = deps.migrationEpoch();
			if (Number.isNaN(epoch)) return true;
			if (epoch === 0) return false;
			return fenceOnReconnect(read(domainId, gatewayId), epoch);
		},
	};
}

export type LeaseService = ReturnType<typeof createLeaseService>;
