// Helper tokens are hashed at rest.

import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import { sha256Hex } from "../../shared/canonical-json.js";
import { DurableStore } from "../../shared/durable-store.js";
import { bindingTokensEqual } from "../../shared/session-tokens.js";

const RecordsSchema = z.array(
	z.object({ tokenId: z.string().min(1), hash: z.string().min(1), createdAt: z.number().int().nonnegative() }),
);

export function createHelperTokens(deps: { dataDir: string; ambient: Pick<Ambient, "now" | "newId" | "randomBytes"> }) {
	const store = new DurableStore(deps.dataDir, "vault-helper");
	let records = RecordsSchema.safeParse(store.load()).data ?? [];

	const mint = (): { tokenId: string; token: string } => {
		const token = deps.ambient.randomBytes(32).toString("base64url");
		const tokenId = deps.ambient.newId();
		records.push({ tokenId, hash: sha256Hex(token), createdAt: deps.ambient.now() });
		store.save(records);
		return { tokenId, token };
	};

	/** Returns the presented token's id. */
	const verify = (token: string | null): string | null => {
		if (!token) return null;
		const hash = sha256Hex(token);
		return records.find((record) => bindingTokensEqual(record.hash, hash))?.tokenId ?? null;
	};

	const revoke = (tokenId: string): boolean => {
		const kept = records.filter((record) => record.tokenId !== tokenId);
		if (kept.length === records.length) return false;
		records = kept;
		store.save(records);
		return true;
	};

	const list = () => records.map(({ tokenId, createdAt }) => ({ tokenId, createdAt }));

	return { mint, verify, revoke, list };
}

export type HelperTokens = ReturnType<typeof createHelperTokens>;
