// Helper tokens are hashed at rest.

import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import { sha256Hex } from "../../shared/canonical-json.js";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import { bindingTokensEqual } from "../../shared/session-tokens.js";

const RecordsSchema = z.array(
	z.object({ tokenId: z.string().min(1), hash: z.string().min(1), createdAt: z.number().int().nonnegative() }),
);
type TokenRecord = z.infer<typeof RecordsSchema>[number];

export interface HelperTokensDeps {
	/** Opened through `openDurable`, so a poisoned file starts this store fresh. */
	store: DurableStore;
	ambient: Pick<Ambient, "now" | "newId" | "randomBytes">;
}

export function createHelperTokens(deps: HelperTokensDeps) {
	const { store } = deps;
	let records: TokenRecord[] = RecordsSchema.parse(store.load() ?? []);

	/** A token only counts once it is on disk. */
	const commit = (next: TokenRecord[]): boolean => {
		const previous = records;
		records = next;
		try {
			store.saveChecked(records);
			return true;
		} catch (error) {
			// An installed snapshot is what a reopen reads.
			if (error instanceof DurableStoreInstalledError) return true;
			records = previous;
			console.warn(`[vault] helper token write failed: ${(error as Error).message}`);
			return false;
		}
	};

	const mint = (): { tokenId: string; token: string } | null => {
		const token = deps.ambient.randomBytes(32).toString("base64url");
		const tokenId = deps.ambient.newId();
		const minted = { tokenId, hash: sha256Hex(token), createdAt: deps.ambient.now() };
		return commit([...records, minted]) ? { tokenId, token } : null;
	};

	/** Returns the presented token's id. */
	const verify = (token: string | null): string | null => {
		if (!token) return null;
		const hash = sha256Hex(token);
		return records.find((record) => bindingTokensEqual(record.hash, hash))?.tokenId ?? null;
	};

	const revoke = (tokenId: string): boolean => {
		const kept = records.filter((record) => record.tokenId !== tokenId);
		return kept.length !== records.length && commit(kept);
	};

	const list = () => records.map(({ tokenId, createdAt }) => ({ tokenId, createdAt }));

	return { mint, verify, revoke, list };
}

export type HelperTokens = ReturnType<typeof createHelperTokens>;
