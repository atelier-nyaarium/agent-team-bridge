import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import type { GatewayRegistration, OwnerServiceHooks } from "../federation-server/ownerServiceHooks.js";
import { createVaultService } from "../federation-server/vault/vaultService.js";
import { fingerprint } from "../shared/crypto.js";
import {
	MAX_VAULT_FIELD_B64,
	VAULT_FIELD_NAMES,
	VAULT_TOMBSTONE_TTL_MS,
	type VaultEntrySealed,
	type VaultPut,
} from "../shared/schemasVault.js";
import { mintIdentitySet } from "../testing/identitySet.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const set = mintIdentitySet({ domainId: "domain", gatewayId: "gateway" });
const domainId = set.domain.id;
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-service-"));
	roots.push(root);
	return root;
};
const registryIn = (root: string) =>
	new OwnerStoreRegistry({
		dataDir: root,
		ownerOf: () => set.domain.owner.sign.pub,
		quotaFor: () => new DomainQuota({ dir: root, limitBytes: 10_000_000, statfs: () => ({ available: 1 << 30 }) }),
		ambient: { now: () => 1_000_000 },
	});
const envelope = (bytes = 32) => ({
	v: 1 as const,
	epoch: 1,
	nonce: Buffer.alloc(12, 1).toString("base64"),
	ciphertext: Buffer.alloc(bytes, 2).toString("base64"),
});
const titled = (): VaultEntrySealed => ({ publicTitle: envelope() });
const write = (id: string, expectedRevision: number, sealed: VaultEntrySealed): VaultPut => ({
	id,
	expectedRevision,
	sealed,
});

describe("vault service", () => {
	it("refuses an oversized field, a full vault, and a store that cannot commit", () => {
		const registry = registryIn(fresh());
		const vault = createVaultService({ registry, maxEntries: 1 });
		const oversized = {
			publicTitle: envelope(),
			value: { ...envelope(), ciphertext: "A".repeat(MAX_VAULT_FIELD_B64 + 4) },
		};
		expect(vault.put(domainId, write("big", 0, oversized), "phone", false)).toMatchObject({
			outcome: "refused",
			refusal: "field_too_large",
		});
		expect(vault.put(domainId, write("one", 0, titled()), "phone", false)).toMatchObject({ outcome: "applied" });
		expect(vault.put(domainId, write("two", 0, titled()), "phone", false)).toMatchObject({
			outcome: "refused",
			refusal: "vault_full",
		});
		// Updates do not consume entry slots.
		expect(vault.put(domainId, write("one", 1, titled()), "phone", false)).toMatchObject({ outcome: "applied" });

		registry.for(domainId).close();
		expect(vault.put(domainId, write("one", 2, titled()), "phone", false)).toMatchObject({
			outcome: "refused",
			refusal: "durability_failure",
		});
		expect(vault.del(domainId, "one", 2)).toMatchObject({ outcome: "refused", refusal: "durability_failure" });
	});

	it("a tombstone wipes the fields, meets a blind re-create, and is swept after the TTL", () => {
		const registry = registryIn(fresh());
		const vault = createVaultService({ registry });
		const sealed = Object.fromEntries(VAULT_FIELD_NAMES.map((name) => [name, envelope()])) as VaultEntrySealed;
		const created = vault.put(domainId, write("key", 0, sealed), "gateway", true);
		expect(created).toMatchObject({ outcome: "applied" });
		const deleted = vault.del(domainId, "key", 1);
		expect(deleted.outcome).toBe("applied");
		// Tombstones preserve identity and update timestamps.
		expect(deleted.entry).toEqual({
			clear: {
				...created.entry?.clear,
				revision: 2,
				tombstone: true,
				changedAt: 2,
				updatedAt: expect.any(Number),
			},
			sealed: {},
		});
		expect(vault.del(domainId, "key", 2)).toMatchObject({ outcome: "refused", refusal: "entry_missing" });
		expect(vault.put(domainId, write("key", 0, titled()), "phone", false)).toMatchObject({
			outcome: "conflict",
			entry: { clear: { tombstone: true, revision: 2 } },
		});
		expect(vault.put(domainId, write("key", 0, titled()), "gateway", true)).toMatchObject({
			outcome: "refused",
			refusal: "exists",
		});
		// Tombstones count toward records, not live entries.
		expect(
			createVaultService({ registry, maxEntries: 1 }).put(domainId, write("other", 0, titled()), "phone", false),
		).toMatchObject({ outcome: "applied" });
		expect(
			createVaultService({ registry, maxRecords: 2 }).put(domainId, write("third", 0, titled()), "phone", false),
		).toMatchObject({ outcome: "refused", refusal: "vault_full" });

		// Delta reads start after held revision.
		const full = vault.read(domainId);
		expect(full.entries.map((entry) => entry.clear.id).sort()).toEqual(["key", "other"]);
		const delta = vault.read(domainId, full.revision - 1);
		expect(delta.entries.map((entry) => entry.clear.id)).toEqual(["other"]);
		expect(vault.read(domainId, full.revision).entries).toEqual([]);

		const before = vault.read(domainId);
		expect(vault.sweep(domainId, 1_000_000 + VAULT_TOMBSTONE_TTL_MS)).toBe(0);
		expect(vault.sweep(domainId, 1_000_000 + VAULT_TOMBSTONE_TTL_MS + 1)).toBe(1);
		const after = vault.read(domainId);
		expect(after.entries.map((entry) => entry.clear.id)).toEqual(["other"]);
		expect(after.revision).toBe(before.revision + 1);
		// A cursor below the swept tombstone gets the full list; one at or past it keeps its delta.
		expect(vault.read(domainId, 1)).toMatchObject({ since: 0 });
		expect(vault.read(domainId, 1).entries.map((entry) => entry.clear.id)).toEqual(["other"]);
		expect(vault.read(domainId, 2)).toMatchObject({ since: 2 });
		expect(vault.read(domainId, 2).entries.map((entry) => entry.clear.id)).toEqual(["other"]);
		expect(vault.read(domainId, after.revision)).toMatchObject({ since: after.revision, entries: [] });
	});

	it("answers a gateway read with durability uncertainty while the owner store is quarantined", () => {
		const root = fresh();
		const store = registryIn(root).for(domainId);
		store.append("rows", { value: 1 });
		store.append("rows", { value: 2 });
		store.close();
		const journal = path.join(root, "owner", domainId, fingerprint(set.domain.owner.sign.pub), "journal-0.log");
		const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
		lines[0] = "{";
		fs.writeFileSync(journal, `${lines.join("\n")}\n`);

		const frames = new Map<string, (reg: GatewayRegistration, params: Record<string, unknown>) => unknown>();
		const hooks = {
			ownerOp: () => undefined,
			gatewayFrame: (
				name: string,
				_mutation: string,
				handler: (reg: GatewayRegistration, params: Record<string, unknown>) => unknown,
			) => frames.set(name, handler),
		} as unknown as OwnerServiceHooks;
		createVaultService({ registry: registryIn(root) }).register(hooks);
		const reg = { domainId, gatewayId: set.gateway.id, signPub: set.gateway.identity.sign.pub, incarnation: 1 };
		expect(frames.get("vault_read")?.(reg, { incarnation: 1 })).toEqual({ outcome: "durability_uncertain" });
	});
});
