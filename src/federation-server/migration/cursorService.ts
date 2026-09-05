// Cursor translations remain stable during migration.

import { translateCursor } from "../../shared/migration-cursor.js";
import type { CursorMapEntry } from "../../shared/schemasMigration.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

export interface CursorDeps {
	registry: OwnerStoreRegistry;
	migrationEpoch: () => number;
}

export function createCursorService(deps: CursorDeps) {
	const mapFor = (domainId: string, address: string): CursorMapEntry[] => {
		const record = deps.registry.for(domainId).get("inbox.address", address);
		const map = (record?.clear as { cursorMap?: CursorMapEntry[] } | undefined)?.cursorMap;
		return Array.isArray(map) ? map : [];
	};

	return {
		mapFor,

		register(hooks: OwnerServiceHooks): void {
			hooks.ownerOp("cursor_translate", async (op, value) => {
				const address = value.address;
				if (address === undefined) return { translation: { kind: "unmapped" } };
				const cursor = { epoch: value.epoch ?? 0, seq: value.seq ?? 0 };
				const translation = translateCursor(cursor, deps.migrationEpoch(), mapFor(op.domainId, address));
				return { translation };
			});
		},
	};
}
