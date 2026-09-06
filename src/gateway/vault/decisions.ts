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
import { coveredBy, shapeFrom } from "./operationSet.js";

export interface VaultDecisionsDeps {
	/** Opened through `openDurable`, so a poisoned file starts this store fresh. */
	store: DurableStore;
	ambient: Pick<Ambient, "newId">;
	sessionCapMs?: number;
}

/** Grant scope: entry, display shape, the programs named, and session. */
export interface GrantScope {
	entryId: string;
	shape: string;
	shapes: string[];
	sessionTarget: string;
}

const GrantsSchema = z.array(VaultGrantSchema);

/**
 * What the owner reads: the grants tab's line, and the title a saved typed value takes. It reads
 * the words as written, so it holds for text no parser accepts. `operationSet` is what a grant
 * covers.
 */
export function operationShape(operation: string): string {
	return shapeFrom(operation.trim().split(/\s+/).filter(Boolean));
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

	/** Session grants cover every shape; a window grant covers a request whose programs it all named. */
	const covers = (scope: GrantScope, now: number): VaultGrant | undefined => {
		sweep(now);
		return grants.find(
			(grant) =>
				grant.sessionTarget === scope.sessionTarget &&
				grant.entryId === scope.entryId &&
				(grant.tier === "session" || (grant.shapes !== undefined && coveredBy(scope.shapes, grant.shapes))),
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
						shapes: scope.shapes,
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
