// Grants are gateway-local and session-bound.

import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import {
	VAULT_SESSION_GRANT_CAP_MS,
	VAULT_WINDOW_MS,
	type VaultDecision,
	type VaultGrant,
	VaultGrantSchema,
} from "../../shared/schemasVault.js";

export interface VaultDecisionsDeps {
	/** Opened through `openDurable`, so a poisoned file starts this store fresh. */
	store: DurableStore;
	ambient: Pick<Ambient, "newId">;
	sessionCapMs?: number;
}

/** Grant scope: entry, shape, and session. */
export interface GrantScope {
	entryId: string;
	shape: string;
	sessionTarget: string;
}

const GrantsSchema = z.array(VaultGrantSchema);

/** Shape uses program and first argument, or the full line after a flag. */
export function operationShape(operation: string): string {
	const tokens = operation.trim().split(/\s+/).filter(Boolean);
	const program = tokens[0]?.split("/").at(-1) ?? "";
	const first = tokens[1];
	if (first === undefined) return program;
	return first.startsWith("-") ? [program, ...tokens.slice(1)].join(" ") : `${program} ${first}`;
}

export function createVaultDecisions(deps: VaultDecisionsDeps) {
	const { store } = deps;
	const sessionCapMs = deps.sessionCapMs ?? VAULT_SESSION_GRANT_CAP_MS;
	let grants: VaultGrant[] = GrantsSchema.parse(store.load() ?? []);

	/** A revocation lands on disk before it is reported; the rest is best effort. */
	const commit = (next: VaultGrant[], checked: boolean): boolean => {
		const previous = grants;
		grants = next;
		if (!checked) {
			store.save(grants);
			return true;
		}
		try {
			store.saveChecked(grants);
			return true;
		} catch (error) {
			// An installed snapshot is what a reopen reads.
			if (error instanceof DurableStoreInstalledError) return true;
			grants = previous;
			console.warn(`[vault] grant write failed: ${(error as Error).message}`);
			return false;
		}
	};
	const sweep = (now: number): void => {
		const kept = grants.filter((grant) => grant.expiresAt === undefined || grant.expiresAt > now);
		if (kept.length !== grants.length) commit(kept, false);
	};

	/** Session grants cover every shape; window grants cover one. */
	const covers = (scope: GrantScope, now: number): VaultGrant | undefined => {
		sweep(now);
		return grants.find(
			(grant) =>
				grant.sessionTarget === scope.sessionTarget &&
				grant.entryId === scope.entryId &&
				(grant.tier === "session" || grant.shape === scope.shape),
		);
	};

	/** Once leaves no grant. */
	const grant = (decision: VaultDecision, scope: GrantScope, now: number): VaultGrant | null => {
		if (decision !== "window" && decision !== "session") return null;
		const granted: VaultGrant =
			decision === "window"
				? {
						grantId: deps.ambient.newId(),
						tier: "window",
						entryId: scope.entryId,
						shape: scope.shape,
						sessionTarget: scope.sessionTarget,
						expiresAt: now + VAULT_WINDOW_MS,
					}
				: {
						grantId: deps.ambient.newId(),
						tier: "session",
						entryId: scope.entryId,
						sessionTarget: scope.sessionTarget,
						expiresAt: now + sessionCapMs,
					};
		commit([...grants, granted], false);
		return granted;
	};

	const list = (now: number): VaultGrant[] => {
		sweep(now);
		return [...grants];
	};

	const revoke = (grantId: string): boolean => {
		const kept = grants.filter((grant) => grant.grantId !== grantId);
		return kept.length !== grants.length && commit(kept, true);
	};

	const sessionEnded = (sessionTarget: string): void => {
		const kept = grants.filter((grant) => grant.sessionTarget !== sessionTarget);
		if (kept.length !== grants.length) commit(kept, true);
	};

	return { covers, grant, list, revoke, sessionEnded };
}

export type VaultDecisions = ReturnType<typeof createVaultDecisions>;
