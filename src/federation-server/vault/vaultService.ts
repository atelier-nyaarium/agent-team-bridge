import {
	MAX_VAULT_ENTRIES_PER_OWNER,
	MAX_VAULT_FIELD_B64,
	MAX_VAULT_RECORDS_PER_OWNER,
	titled,
	VAULT_FIELD_NAMES,
	VAULT_TOMBSTONE_TTL_MS,
	VaultCreateParamsSchema,
	type VaultEntryClear,
	type VaultEntrySealed,
	type VaultListResult,
	type VaultPut,
	VaultReadParamsSchema,
	type VaultStoredEntry,
	type VaultWriteResult,
} from "../../shared/schemasVault.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import { OwnerQuarantined, type StateRecord } from "../owner/ownerStateStore.js";
import type { GatewayRegistration, OwnerServiceHooks } from "../ownerServiceHooks.js";

type Deps = {
	registry: OwnerStoreRegistry;
	pokeOwner?: (domainId: string, revision: number) => void;
	now?: () => number;
	maxEntries?: number;
	maxRecords?: number;
};

const META_ID = "vault.meta";

/** Sealed fields under a clear envelope; the Router opens none. */
export function createVaultService(deps: Deps) {
	const now = deps.now ?? (() => deps.registry.now());
	const maxEntries = deps.maxEntries ?? MAX_VAULT_ENTRIES_PER_OWNER;
	const maxRecords = deps.maxRecords ?? MAX_VAULT_RECORDS_PER_OWNER;
	const storeOf = (domainId: string) => deps.registry.for(domainId);
	const metaOf = (store: ReturnType<typeof storeOf>) => {
		const clear = store.get("vault.meta", META_ID)?.clear;
		return { revision: Number(clear?.revision ?? 0), floor: Number(clear?.floor ?? 0) };
	};
	const revisionOf = (store: ReturnType<typeof storeOf>) => metaOf(store).revision;
	const entryOf = (record: StateRecord): VaultStoredEntry => ({
		clear: record.clear as unknown as VaultEntryClear,
		sealed: (record.sealed ?? {}) as VaultEntrySealed,
	});
	const oversized = (sealed: VaultEntrySealed) =>
		VAULT_FIELD_NAMES.some((name) => (sealed[name]?.ciphertext.length ?? 0) > MAX_VAULT_FIELD_B64);

	/** Tombstones keep deletions convergent; a cursor below the floor missed a swept one and gets the full list. */
	const read = (domainId: string, sinceRevision = 0): VaultListResult => {
		const store = storeOf(domainId);
		const meta = metaOf(store);
		const since = sinceRevision < meta.floor ? 0 : sinceRevision;
		return {
			revision: meta.revision,
			since,
			entries: store
				.list("vault.entry")
				.filter((record) => Number(record.clear.changedAt) > since)
				.map(entryOf),
		};
	};

	/** Entry and revision share one journal line. */
	const commit = (
		domainId: string,
		next: number,
		write: (tx: Parameters<Parameters<ReturnType<typeof storeOf>["batch"]>[0]>[0]) => void,
		floor = metaOf(storeOf(domainId)).floor,
	): "ok" | "conflict" | "failed" => {
		const store = storeOf(domainId);
		const meta = store.get("vault.meta", META_ID);
		const result = store.batch((tx) => {
			write(tx);
			tx.put("vault.meta", META_ID, meta?.version ?? null, { clear: { revision: next, floor } });
		});
		if (result.kind === "conflict") return "conflict";
		// Durability uncertainty still applied.
		if (result.kind !== "ok" && result.kind !== "durability_uncertain") return "failed";
		deps.pokeOwner?.(domainId, next);
		return "ok";
	};

	/** Gateway creates only; phone writes may update. */
	const put = (
		domainId: string,
		input: VaultPut,
		createdBy: VaultEntryClear["createdBy"],
		createOnly: boolean,
	): VaultWriteResult => {
		const store = storeOf(domainId);
		const current = store.get("vault.entry", input.id);
		const revision = revisionOf(store);
		const held = current ? entryOf(current) : undefined;
		const winner = held ? { entry: held } : {};
		const refuse = (refusal: string): VaultWriteResult => ({ outcome: "refused", revision, ...winner, refusal });
		if (!titled(input.sealed)) return refuse("untitled");
		if (oversized(input.sealed)) return refuse("field_too_large");
		if (createOnly && (current || input.expectedRevision !== 0)) return refuse("exists");
		const currentRevision = held?.clear.revision ?? 0;
		if (input.expectedRevision !== currentRevision) return { outcome: "conflict", revision, ...winner };
		if (!current) {
			const records = store.list("vault.entry");
			if (records.length >= maxRecords) return refuse("vault_full");
			if (records.filter((record) => record.clear.tombstone !== true).length >= maxEntries)
				return refuse("vault_full");
		} else if (held?.clear.tombstone) {
			const live = store.list("vault.entry").filter((record) => record.clear.tombstone !== true);
			if (live.length >= maxEntries) return refuse("vault_full");
		}
		const at = now();
		const next = revision + 1;
		const clear: VaultEntryClear = {
			id: input.id,
			revision: currentRevision + 1,
			tombstone: false,
			changedAt: next,
			createdBy: held?.clear.createdBy ?? createdBy,
			createdAt: held?.clear.createdAt ?? at,
			updatedAt: at,
		};
		const committed = commit(domainId, next, (tx) =>
			tx.put("vault.entry", input.id, current?.version ?? null, { clear, sealed: input.sealed }),
		);
		if (committed === "conflict") return { outcome: "conflict", revision, ...winner };
		if (committed === "failed") return refuse("durability_failure");
		return { outcome: "applied", revision: next, entry: { clear, sealed: input.sealed } };
	};

	/** Deletes clear fields but retain tombstones. */
	const del = (domainId: string, id: string, expectedRevision: number): VaultWriteResult => {
		const store = storeOf(domainId);
		const current = store.get("vault.entry", id);
		const revision = revisionOf(store);
		if (!current) return { outcome: "refused", revision, refusal: "entry_missing" };
		const held = entryOf(current);
		if (held.clear.tombstone) return { outcome: "refused", revision, entry: held, refusal: "entry_missing" };
		if (held.clear.revision !== expectedRevision) return { outcome: "conflict", revision, entry: held };
		const next = revision + 1;
		const clear: VaultEntryClear = {
			...held.clear,
			revision: held.clear.revision + 1,
			tombstone: true,
			changedAt: next,
			updatedAt: now(),
		};
		const committed = commit(domainId, next, (tx) =>
			tx.put("vault.entry", id, current.version, { clear, sealed: {} }),
		);
		if (committed === "conflict") return { outcome: "conflict", revision, entry: held };
		if (committed === "failed") return { outcome: "refused", revision, entry: held, refusal: "durability_failure" };
		return { outcome: "applied", revision: next, entry: { clear, sealed: {} } };
	};

	/** Sweep expired tombstones in one revision. */
	const sweep = (domainId: string, at = now()): number => {
		const store = storeOf(domainId);
		const dead = store
			.list("vault.entry")
			.filter(
				(record) =>
					record.clear.tombstone === true && at - Number(record.clear.updatedAt) > VAULT_TOMBSTONE_TTL_MS,
			);
		if (dead.length === 0) return 0;
		const meta = metaOf(store);
		const floor = Math.max(meta.floor, ...dead.map((record) => Number(record.clear.changedAt)));
		const committed = commit(
			domainId,
			meta.revision + 1,
			(tx) => {
				for (const record of dead) tx.del("vault.entry", record.id, record.version);
			},
			floor,
		);
		return committed === "ok" ? dead.length : 0;
	};

	const register = (hooks: OwnerServiceHooks) => {
		hooks.ownerOp("vault_list", (op, value) => read(op.domainId, value.sinceRevision));
		hooks.ownerOp("vault_put", (op, value) => put(op.domainId, value.put, "phone", false));
		hooks.ownerOp("vault_delete", (op, value) => del(op.domainId, value.id, value.expectedRevision));
		hooks.gatewayFrame("vault_read", "read", (reg: GatewayRegistration, params) => {
			try {
				return read(reg.domainId, VaultReadParamsSchema.parse(params).sinceRevision);
			} catch (error) {
				if (error instanceof OwnerQuarantined) return { outcome: "durability_uncertain" as const };
				throw error;
			}
		});
		hooks.gatewayFrame("vault_create", "value", (reg: GatewayRegistration, params) =>
			put(reg.domainId, VaultCreateParamsSchema.parse(params).put, "gateway", true),
		);
	};

	return { read, put, del, sweep, register };
}
