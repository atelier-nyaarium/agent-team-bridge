import { REGISTER_MAX_SKEW_MS } from "../shared/admission.js";
import type { Ambient } from "../shared/ambient.js";
import { fingerprint } from "../shared/crypto.js";
import {
	type EnrollResult,
	type SignedDeleteDomain,
	type SignedFirstRoot,
	type SignedProvisionTenant,
	type SignedRemoveTenant,
	type SignedSetDisplayName,
	verifyDeleteDomain,
	verifyFirstRoot,
	verifyProvisionTenant,
	verifyRemoveTenant,
	verifySetDisplayName,
} from "../shared/federation-lifecycle.js";
import { WIRE_NONCE_BYTES } from "../shared/wire-vocabulary.js";
import { sanitizeDomainId } from "./enrollmentCoordinator.js";
import type { EnrollmentState, PendingTenantRecord, SeenAdminNonce } from "./federationSecret.js";
import type { FileSecretStore } from "./fileSecretStore.js";

////////////////////////////////
//  Interfaces & Types

export const DEFAULT_INVITE_TTL_MS = 86_400_000;

const ADMIN_OP_MAX_SKEW_MS = REGISTER_MAX_SKEW_MS;

const MAX_SEEN_ADMIN_NONCES = 50_000;

type AdminOpEffect<T> =
	| { commit: true; enrollment: Record<string, EnrollmentState>; value: T }
	| { commit: false; value: T };

////////////////////////////////
//  Class

export class TenantAdmin {
	public constructor(
		private readonly store: FileSecretStore,
		private readonly adminSignPub: () => string | null,
		private readonly ambient: Pick<Ambient, "now" | "randomBytes">,
		private readonly inviteTtlMs: number = DEFAULT_INVITE_TTL_MS,
	) {}

	private now(): number {
		return this.ambient.now();
	}

	public async provisionTenant(signed: SignedProvisionTenant): Promise<EnrollResult & { nonce?: string }> {
		const adminKey = this.adminSignPub();
		if (!adminKey) return { ok: false, error: "no admin key pinned (admin Domain not rooted)" };
		if (!verifyProvisionTenant(signed, adminKey)) return { ok: false, error: "not admin-signed" };
		const { domainId: rawId, displayName, issuedAt, nonce } = signed.provision;
		const domainId = sanitizeDomainId(rawId);
		if (domainId === this.store.adminDomainId()) {
			return { ok: false, error: "cannot provision the admin's Domain" };
		}
		const inviteNonce = this.ambient.randomBytes(WIRE_NONCE_BYTES).toString("base64");
		const pending: PendingTenantRecord = {
			displayName,
			nonce: inviteNonce,
			issuedAt: this.now(),
			ttlMs: this.inviteTtlMs,
			rooted: false,
		};
		try {
			return await this.runGuardedAdminOp<EnrollResult & { nonce?: string }>({
				scope: "provision_tenant",
				domainId,
				issuedAt,
				nonce,
				verify: () => null,
				effect: (enrollment) => {
					const current = enrollment[domainId] ?? null;
					if (current?.ownerSignPub != null)
						return { commit: false, value: { ok: false, error: "Domain already rooted" } };
					const next: EnrollmentState = {
						...(current ?? { ownerSignPub: null, ownerBoxPub: null, admissions: [], revocations: [] }),
						ownerSignPub: null,
						ownerBoxPub: null,
						displayName,
						pendingTenant: pending,
					};
					return {
						commit: true,
						enrollment: { ...enrollment, [domainId]: next },
						value: { ok: true, nonce: inviteNonce },
					};
				},
			});
		} catch (err) {
			return { ok: false, error: `persist failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	public async removeTenant(signed: SignedRemoveTenant): Promise<EnrollResult> {
		const adminKey = this.adminSignPub();
		if (!adminKey) return { ok: false, error: "no admin key pinned (admin Domain not rooted)" };
		if (!verifyRemoveTenant(signed, adminKey)) return { ok: false, error: "not admin-signed" };
		const { domainId: rawId, issuedAt, nonce } = signed.removal;
		const domainId = sanitizeDomainId(rawId);
		if (domainId === this.store.adminDomainId()) {
			return { ok: false, error: "cannot remove the admin's Domain" };
		}
		try {
			return await this.runGuardedAdminOp<EnrollResult>({
				scope: "remove_tenant",
				domainId,
				issuedAt,
				nonce,
				verify: () => null,
				effect: (enrollment) => {
					const next = { ...enrollment };
					delete next[domainId];
					return { commit: true, enrollment: next, value: { ok: true } };
				},
			});
		} catch (err) {
			return { ok: false, error: `persist failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	public async firstRoot(signed: SignedFirstRoot): Promise<EnrollResult> {
		if (!verifyFirstRoot(signed)) return { ok: false, error: "first_root not self-signed" };
		const { domainId: rawId, ownerSignPub, ownerBoxPub, nonce, issuedAt } = signed.firstRoot;
		const skewErr = this.checkSkew(issuedAt);
		if (skewErr) return { ok: false, error: skewErr };
		const domainId = sanitizeDomainId(rawId);
		const nowMs = this.now();
		let branch = "no decision";
		const signer = fingerprint(ownerSignPub);
		try {
			const result = await this.store.mutateSecret<EnrollResult>(({ enrollment, seenAdminNonces }) => {
				const current = enrollment[domainId] ?? null;
				const pending = current?.pendingTenant;
				const OPAQUE_REJECT = "invalid or expired invite";
				if (!current || !pending) {
					branch = "rejected: no pending slice";
					return { commit: false, value: { ok: false, error: OPAQUE_REJECT } };
				}
				if (pending.rooted || current.ownerSignPub != null) {
					if (current.ownerSignPub === ownerSignPub) {
						branch = "idempotent: already rooted at this key";
						return { commit: false, value: { ok: true } };
					}
					branch = "rejected: rooted at a different key";
					return { commit: false, value: { ok: false, error: OPAQUE_REJECT } };
				}
				if (pending.nonce !== nonce) {
					branch = "rejected: invite nonce mismatch";
					return { commit: false, value: { ok: false, error: OPAQUE_REJECT } };
				}
				if (
					Object.entries(enrollment).some(
						([otherDomainId, state]) => otherDomainId !== domainId && state.ownerSignPub === ownerSignPub,
					)
				) {
					branch = "rejected: owner key already roots another Domain";
					return { commit: false, value: { ok: false, error: "owner key already roots a Domain" } };
				}
				if (nowMs > pending.issuedAt + pending.ttlMs) {
					branch = "rejected: invite expired";
					return { commit: false, value: { ok: false, error: "invite expired" } };
				}
				branch = "rooted";
				const next: EnrollmentState = {
					...current,
					ownerSignPub,
					ownerBoxPub,
					pendingTenant: { ...pending, rooted: true },
				};
				return {
					commit: true,
					enrollment: { ...enrollment, [domainId]: next },
					seenAdminNonces,
					value: { ok: true },
				};
			});
			if (result.ok) console.log(`[TenantAdmin] first_root domain "${domainId}" ${branch} (owner ${signer})`);
			else console.warn(`[TenantAdmin] first_root domain "${domainId}" ${branch} (signer ${signer})`);
			return result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[TenantAdmin] first_root domain "${domainId}" persist failed: ${msg}`);
			return { ok: false, error: `persist failed: ${msg}` };
		}
	}

	public async setDisplayName(
		signed: SignedSetDisplayName,
	): Promise<EnrollResult & { domainId?: string; displayName?: string }> {
		const { domainId: rawId, displayName, issuedAt, nonce } = signed.rename;
		const domainId = sanitizeDomainId(rawId);
		try {
			return await this.runGuardedAdminOp<EnrollResult & { domainId?: string; displayName?: string }>({
				scope: "set_display_name",
				domainId,
				issuedAt,
				nonce,
				replayError: "owner op replayed",
				verify: (enrollment) => {
					const current = enrollment[domainId] ?? null;
					if (!current?.ownerSignPub) return "Domain not rooted";
					if (!verifySetDisplayName(signed, current.ownerSignPub)) return "not owner-signed";
					return null;
				},
				effect: (enrollment) => {
					const current = enrollment[domainId];
					const next: EnrollmentState = { ...current, displayName };
					return {
						commit: true,
						enrollment: { ...enrollment, [domainId]: next },
						value: { ok: true, domainId, displayName },
					};
				},
			});
		} catch (err) {
			return { ok: false, error: `persist failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	public async deleteDomain(signed: SignedDeleteDomain): Promise<EnrollResult> {
		const { domainId: rawId, issuedAt, nonce } = signed.deletion;
		const domainId = sanitizeDomainId(rawId);
		try {
			return await this.runGuardedAdminOp<EnrollResult>({
				scope: "delete_domain",
				domainId,
				issuedAt,
				nonce,
				replayError: "owner op replayed",
				verify: (enrollment) => {
					const current = enrollment[domainId] ?? null;
					if (!current?.ownerSignPub) return "Domain not rooted";
					if (!verifyDeleteDomain(signed, current.ownerSignPub)) return "not owner-signed";
					return null;
				},
				effect: (enrollment) => {
					const next = { ...enrollment };
					delete next[domainId];
					return { commit: true, enrollment: next, value: { ok: true } };
				},
			});
		} catch (err) {
			return { ok: false, error: `persist failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	////////////////////////////////
	//  Functions & Helpers

	private checkSkew(issuedAt: number): string | null {
		if (Math.abs(this.now() - issuedAt) > ADMIN_OP_MAX_SKEW_MS) return "admin op is stale";
		return null;
	}

	private runGuardedAdminOp<T extends EnrollResult>(args: {
		scope: string;
		domainId: string;
		issuedAt: number;
		nonce: string;
		verify: (enrollment: Record<string, EnrollmentState>) => string | null;
		effect: (enrollment: Record<string, EnrollmentState>) => AdminOpEffect<T>;
		replayError?: string;
	}): Promise<T> {
		const skewErr = this.checkSkew(args.issuedAt);
		if (skewErr) return Promise.resolve(fail<T>(skewErr));
		return this.store.mutateSecret<T>(({ enrollment, seenAdminNonces }) => {
			const verifyErr = args.verify(enrollment);
			if (verifyErr) return { commit: false, value: fail<T>(verifyErr) };
			const guard = this.recordAdminNonce(seenAdminNonces, args.scope, args.domainId, args.nonce);
			if (!guard.fresh) return { commit: false, value: fail<T>(args.replayError ?? "admin op replayed") };
			const outcome = args.effect(enrollment);
			if (!outcome.commit) return { commit: false, value: outcome.value };
			return {
				commit: true,
				enrollment: outcome.enrollment,
				seenAdminNonces: guard.next,
				value: outcome.value,
			};
		});
	}

	private recordAdminNonce(
		ledger: SeenAdminNonce[],
		scope: string,
		domainId: string,
		nonce: string,
	): { fresh: true; next: SeenAdminNonce[] } | { fresh: false } {
		const key = `${scope}\n${domainId}\n${nonce}`;
		const cutoff = this.now() - 2 * ADMIN_OP_MAX_SKEW_MS;
		const live = ledger.filter((e) => e.at > cutoff);
		if (live.some((e) => e.nonce === key)) return { fresh: false };
		live.push({ nonce: key, at: this.now() });
		const next = live.length > MAX_SEEN_ADMIN_NONCES ? live.slice(live.length - MAX_SEEN_ADMIN_NONCES) : live;
		return { fresh: true, next };
	}
}

////////////////////////////////
//  Functions & Helpers

function fail<T extends EnrollResult>(error: string): T {
	return { ok: false, error } as T;
}
