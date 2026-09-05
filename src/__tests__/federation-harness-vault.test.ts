import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	VAULT_PRIVATE_TITLE_KIND,
	VAULT_PUBLIC_TITLE_KIND,
	VAULT_VALUE_KIND,
	type VaultFieldKind,
	vaultAadKind,
} from "../shared/content-envelope.js";
import {
	VAULT_TOMBSTONE_TTL_MS,
	type VaultEntrySealed,
	VaultListResultSchema,
	VaultWriteResultSchema,
} from "../shared/schemasVault.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("federation harness: vault", () => {
	let h: FederationHarness;
	beforeAll(async () => {
		h = await startFederationHarness();
	});
	afterAll(async () => {
		await h.close();
	});

	const field = (kind: VaultFieldKind, id: string, text: string) => h.phone.seal(text, vaultAadKind(kind, id));
	const put = async (id: string, expectedRevision: number, sealed: VaultEntrySealed) =>
		VaultWriteResultSchema.parse(await h.phone.send({ kind: "vault_put", put: { id, expectedRevision, sealed } }));
	const gatewayList = async () => {
		const answer = await h.gateway.faults.routerInboxCall("vault_read", {});
		return VaultListResultSchema.parse(answer.result);
	};

	it("a phone puts an entry, a gateway reads it sealed, and only the key holder opens it", async () => {
		const id = "deploy-key";
		const written = await put(id, 0, {
			publicTitle: field(VAULT_PUBLIC_TITLE_KIND, id, "Deploy key"),
			value: field(VAULT_VALUE_KIND, id, "hunter2"),
		});
		expect(written.outcome).toBe("applied");
		expect(written.entry?.clear).toMatchObject({ id, revision: 1, tombstone: false, createdBy: "phone" });

		const list = await gatewayList();
		const stored = list.entries.find((entry) => entry.clear.id === id);
		if (!stored?.sealed.value) throw new Error("the gateway did not read the sealed value");
		expect(h.phone.openText(stored.sealed.value, vaultAadKind(VAULT_VALUE_KIND, id))).toBe("hunter2");
		// AAD binds the entry ID.
		expect(() => h.phone.openText(stored.sealed.value as never, vaultAadKind(VAULT_VALUE_KIND, "other"))).toThrow();

		const listed = VaultListResultSchema.parse(await h.phone.send({ kind: "vault_list" }));
		expect(listed.revision).toBe(list.revision);
		expect(listed.entries.map((entry) => entry.clear.id)).toContain(id);
		expect(JSON.stringify(list)).not.toContain("hunter2");
		// The plane carries the revision a phone lists from.
		const { planes } = await h.phone.planesRead();
		expect(planes.find((plane) => plane.name === "vault")).toMatchObject({ version: listed.revision });

		// Current revision yields empty delta.
		const caughtUp = VaultListResultSchema.parse(
			await h.phone.send({ kind: "vault_list", sinceRevision: listed.revision }),
		);
		expect(caughtUp.entries).toEqual([]);
		const behind = await h.gateway.faults.routerInboxCall("vault_read", { sinceRevision: listed.revision - 1 });
		expect(VaultListResultSchema.parse(behind.result).entries.map((entry) => entry.clear.id)).toEqual([id]);
	});

	it("a stale revision conflicts and carries the winner; a delete needs the current one", async () => {
		const id = "rotated";
		const first = await put(id, 0, { privateTitle: field(VAULT_PRIVATE_TITLE_KIND, id, "Rotated") });
		expect(first.outcome).toBe("applied");
		const stale = await put(id, 0, { privateTitle: field(VAULT_PRIVATE_TITLE_KIND, id, "Rotated again") });
		expect(stale.outcome).toBe("conflict");
		expect(stale.entry?.clear.revision).toBe(1);
		expect(stale.entry?.sealed.privateTitle).toEqual(first.entry?.sealed.privateTitle);

		const second = await put(id, 1, { privateTitle: field(VAULT_PRIVATE_TITLE_KIND, id, "Rotated again") });
		expect(second.outcome).toBe("applied");
		expect(second.entry?.clear).toMatchObject({ revision: 2, createdBy: "phone" });

		// Schema rejects untitled entries.
		const untitled = await h.phone.send({
			kind: "vault_put",
			put: { id: "nameless", expectedRevision: 0, sealed: { value: field(VAULT_VALUE_KIND, "nameless", "x") } },
		});
		expect(untitled).toMatchObject({ outcome: "refused", reason: "malformed" });

		const staleDelete = VaultWriteResultSchema.parse(
			await h.phone.send({ kind: "vault_delete", id, expectedRevision: 1 }),
		);
		expect(staleDelete.outcome).toBe("conflict");
		const deleted = VaultWriteResultSchema.parse(
			await h.phone.send({ kind: "vault_delete", id, expectedRevision: 2 }),
		);
		expect(deleted.outcome).toBe("applied");
		expect(deleted.entry).toEqual({
			clear: {
				...second.entry?.clear,
				tombstone: true,
				revision: 3,
				changedAt: deleted.revision,
				updatedAt: expect.any(Number),
			},
			sealed: {},
		});
		// Lists include tombstones for convergence.
		const tombstone = (await gatewayList()).entries.find((entry) => entry.clear.id === id);
		expect(tombstone?.clear.tombstone).toBe(true);
		expect(tombstone?.sealed).toEqual({});

		// Tombstones block blind recreation; revision enables revival.
		const blind = await put(id, 0, { privateTitle: field(VAULT_PRIVATE_TITLE_KIND, id, "Back") });
		expect(blind).toMatchObject({ outcome: "conflict", entry: { clear: { tombstone: true, revision: 3 } } });
		const revived = await put(id, 3, { privateTitle: field(VAULT_PRIVATE_TITLE_KIND, id, "Back") });
		expect(revived.entry?.clear).toMatchObject({ tombstone: false, revision: 4, createdBy: "phone" });
	});

	it("a gateway creates but never updates, and the migration fence holds the create", async () => {
		const id = "captured";
		const create = (entryId: string, expectedRevision = 0) =>
			h.gateway.faults.routerInboxCall("vault_create", {
				put: {
					id: entryId,
					expectedRevision,
					sealed: { publicTitle: field(VAULT_PUBLIC_TITLE_KIND, entryId, "Captured") },
				},
			});
		const created = VaultWriteResultSchema.parse((await create(id)).result);
		expect(created.outcome).toBe("applied");
		expect(created.entry?.clear).toMatchObject({ id, revision: 1, createdBy: "gateway" });

		const again = VaultWriteResultSchema.parse((await create(id, 1)).result);
		expect(again).toMatchObject({ outcome: "refused", refusal: "exists" });

		// Registering under the window records the lease the fence reads.
		const previous = process.env.ROUTER_MIGRATION_EPOCH;
		process.env.ROUTER_MIGRATION_EPOCH = "7";
		try {
			await h.restartGateway();
			const fenced = await create("fenced");
			expect(fenced.result).toMatchObject({ outcome: "refused", reason: "migrating" });
			expect((await gatewayList()).entries.map((entry) => entry.clear.id)).toContain(id);
		} finally {
			if (previous === undefined) delete process.env.ROUTER_MIGRATION_EPOCH;
			else process.env.ROUTER_MIGRATION_EPOCH = previous;
		}
		expect(VaultWriteResultSchema.parse((await create("fenced")).result).outcome).toBe("applied");
	});

	it("the Router's sweep holds a tombstone under the fence and drops it past the TTL", async () => {
		const id = "swept";
		await put(id, 0, { publicTitle: field(VAULT_PUBLIC_TITLE_KIND, id, "Swept") });
		const deleted = VaultWriteResultSchema.parse(
			await h.phone.send({ kind: "vault_delete", id, expectedRevision: 1 }),
		);
		const past = Number(deleted.entry?.clear.updatedAt) + VAULT_TOMBSTONE_TTL_MS + 1;
		const listed = async () => (await gatewayList()).entries.find((entry) => entry.clear.id === id);

		// An unready lease holds the Domain.
		const previous = process.env.ROUTER_MIGRATION_EPOCH;
		process.env.ROUTER_MIGRATION_EPOCH = "7";
		try {
			await h.restartGateway();
			h.router.server.sweep(past);
			expect((await listed())?.clear.tombstone).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.ROUTER_MIGRATION_EPOCH;
			else process.env.ROUTER_MIGRATION_EPOCH = previous;
		}
		h.router.server.sweep(past);
		expect(await listed()).toBeUndefined();
	});
});
