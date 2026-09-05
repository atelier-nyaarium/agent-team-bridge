// Grants are gateway-local and session-bound.

import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import { DurableStore } from "../../shared/durable-store.js";
import {
	VAULT_SESSION_GRANT_CAP_MS,
	VAULT_WINDOW_MS,
	type VaultDecision,
	type VaultGrant,
	VaultGrantSchema,
} from "../../shared/schemasVault.js";

export interface VaultDecisionsDeps {
	dataDir: string;
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
	const store = new DurableStore(deps.dataDir, "vault-decisions");
	const sessionCapMs = deps.sessionCapMs ?? VAULT_SESSION_GRANT_CAP_MS;
	let grants: VaultGrant[] = GrantsSchema.safeParse(store.load()).data ?? [];

	const persist = () => store.save(grants);
	const keep = (kept: VaultGrant[]) => {
		if (kept.length === grants.length) return false;
		grants = kept;
		persist();
		return true;
	};
	const sweep = (now: number) =>
		keep(grants.filter((grant) => grant.expiresAt === undefined || grant.expiresAt > now));

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
		grants.push(granted);
		persist();
		return granted;
	};

	const list = (now: number): VaultGrant[] => {
		sweep(now);
		return [...grants];
	};

	const revoke = (grantId: string): boolean => keep(grants.filter((grant) => grant.grantId !== grantId));

	const sessionEnded = (sessionTarget: string): void => {
		keep(grants.filter((grant) => grant.sessionTarget !== sessionTarget));
	};

	return { covers, grant, list, revoke, sessionEnded };
}

export type VaultDecisions = ReturnType<typeof createVaultDecisions>;
