import { describe, expect, it } from "vitest";
import { createVaultClient } from "../gateway/router/vaultClient.js";
import type { VaultStoredEntry } from "../shared/schemasVault.js";

const entry = (id: string, changedAt: number, tombstone = false): VaultStoredEntry => ({
	clear: { id, revision: 1, tombstone, changedAt, createdBy: "phone", createdAt: 1, updatedAt: 1 },
	sealed: {},
});

/** Test-controlled Router list. */
function bench() {
	let revision = 0;
	let entries: VaultStoredEntry[] = [];
	const reads: number[] = [];
	const client = createVaultClient({
		domainId: "domain",
		gatewayId: "gateway",
		ownerSignPub: () => "owner",
		keys: { seal: () => ({ kind: "no_key" }), open: () => ({ kind: "bad_tag" }) },
		call: async (_name, params) => {
			const since = Number(params.sinceRevision ?? 0);
			reads.push(since);
			return { result: { revision, since, entries: entries.filter((e) => e.clear.changedAt > since) } };
		},
	});
	return {
		client,
		reads,
		set: (next: number, list: VaultStoredEntry[]) => {
			revision = next;
			entries = list;
		},
	};
}

describe("vault client", () => {
	it("holds the Router's list through deltas, and starts over when the Router's revision falls behind", async () => {
		const { client, reads, set } = bench();
		set(5, [entry("a", 3), entry("b", 5)]);
		expect(await client.refresh()).toEqual({ kind: "ok", revision: 5 });
		expect(client.live().map((e) => e.clear.id)).toEqual(["a", "b"]);

		set(6, [entry("a", 3), entry("b", 6, true)]);
		await client.refresh();
		expect(reads.at(-1)).toBe(5);
		expect(client.live().map((e) => e.clear.id)).toEqual(["a"]);
		expect(client.stored("b")).toBeUndefined();

		// Lower revision replaces held list.
		set(2, [entry("c", 2)]);
		expect(await client.refresh()).toEqual({ kind: "ok", revision: 2 });
		expect(reads.slice(-2)).toEqual([6, 0]);
		expect(client.live().map((e) => e.clear.id)).toEqual(["c"]);
	});

	it("names durability uncertainty and malformed answers apart", async () => {
		const answers: unknown[] = [{ outcome: "durability_uncertain" }, { nope: true }];
		const client = createVaultClient({
			domainId: "domain",
			gatewayId: "gateway",
			ownerSignPub: () => "owner",
			keys: { seal: () => ({ kind: "no_key" }), open: () => ({ kind: "bad_tag" }) },
			call: async () => ({ result: answers.shift() }),
		});
		expect(await client.refresh()).toEqual({ kind: "unavailable", error: "vault durability is uncertain" });
		expect(await client.refresh()).toEqual({ kind: "unavailable", error: "malformed vault_read answer" });
	});
});
