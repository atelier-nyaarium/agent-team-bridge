import fs from "node:fs";
import path from "node:path";
import type { MigrationWindow } from "../../shared/migration-fence.js";
import {
	authorityReady,
	fenceOnReconnect,
	type LeaseState,
	type MigrationLease,
} from "../../shared/migration-lease.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";

/** A present unreadable file fences the Router. */
export function readRouterMigrationWindow(): MigrationWindow {
	const file = path.join(process.env.DATA_DIR || "/app/data", "migration-epoch");
	if (fs.existsSync(file)) {
		try {
			const raw = fs.readFileSync(file, "utf8").trim();
			if (!/^[1-9][0-9]*$/.test(raw)) return { fenced: true, epoch: null };
			const epoch = Number(raw);
			return Number.isSafeInteger(epoch) ? { fenced: true, epoch } : { fenced: true, epoch: null };
		} catch {
			return { fenced: true, epoch: null };
		}
	}
	const raw = process.env.ROUTER_MIGRATION_EPOCH ?? "";
	if (!/^[1-9][0-9]*$/.test(raw)) return { fenced: false, epoch: null };
	const epoch = Number(raw);
	return Number.isSafeInteger(epoch) ? { fenced: true, epoch } : { fenced: false, epoch: null };
}

export interface LeaseDeps {
	registry: OwnerStoreRegistry;
	migrationWindow: () => MigrationWindow;
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
			const lease = { ...(current?.clear ?? {}), state, epoch: deps.migrationWindow().epoch ?? 0 };
			store.put("migration", gatewayId, current?.version ?? null, { clear: lease });
		},

		/** Stamps completed migration. */
		complete(domainId: string, gatewayId: string): void {
			const store = deps.registry.for(domainId);
			const current = store.get("migration", gatewayId);
			const lease = {
				...(current?.clear ?? { state: "active" }),
				completedEpoch: deps.migrationWindow().epoch ?? 0,
			};
			store.put("migration", gatewayId, current?.version ?? null, { clear: lease });
		},

		ready(domainId: string): boolean {
			const window = deps.migrationWindow();
			return !window.fenced || (window.epoch !== null && authorityReady(list(domainId), window.epoch));
		},

		fenced(domainId: string, gatewayId: string): boolean {
			const window = deps.migrationWindow();
			if (!window.fenced) return false;
			if (window.epoch === null) return true;
			return fenceOnReconnect(read(domainId, gatewayId), window.epoch);
		},
	};
}

export type LeaseService = ReturnType<typeof createLeaseService>;
