import { randomBytes } from "node:crypto";
import {
	type DomainSnapshot,
	type SignedAdmission,
	type SignedRevocation,
	verifyAdmission,
	verifyRevocation,
} from "../shared/admission.js";
import { fingerprint, type Identity } from "../shared/crypto.js";
import {
	type EnrollOp,
	type EnrollOwnerPayload,
	type EnrollResult,
	type SignedXDomainLinkEdge,
	type SignedXDomainLinkRevocation,
	verifyXDomainLinkEdge,
	verifyXDomainLinkRevocation,
} from "../shared/federation-lifecycle.js";
import { WIRE_NONCE_BYTES } from "../shared/wire-vocabulary.js";
import type { EnrollmentState, EnrollmentStore } from "./federationSecret.js";
import type { TenantAdmin } from "./tenantAdmin.js";

////////////////////////////////
//  Interfaces & Types

export type DomainStatus = "rooted" | "pending" | "unrooted";

export interface DomainMeta {
	status: DomainStatus;
	displayName: string | null;
}

export function sanitizeDomainId(raw: string | undefined | null): string {
	const slug = (raw ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) throw new Error("domain id is empty after sanitizing");
	return slug;
}

////////////////////////////////
//  Class

const DEFAULT_NONCE_TTL_MS = 600_000;

export class EnrollmentCoordinator {
	private state: EnrollmentState;
	private readonly nonces = new Map<string, number>();
	private readonly nonceCleanups = new Map<string, () => void>();

	public constructor(
		private readonly identity: Identity,
		private readonly store: EnrollmentStore,
		private readonly domainId: string,
		private readonly nonceTtlMs: number = DEFAULT_NONCE_TTL_MS,
	) {
		this.state = store.load() ?? { ownerSignPub: null, ownerBoxPub: null, admissions: [], revocations: [] };
	}

	public refresh(): void {
		const state = this.store.load();
		if (state) this.state = state;
	}

	public get sasFingerprint(): string {
		return fingerprint(this.identity.sign.pub);
	}

	public get rooted(): boolean {
		return this.state.ownerSignPub !== null;
	}

	public mintEnrollOwner(domainId: string, routerAddr: string, nowMs: number): EnrollOwnerPayload {
		const nonce = randomBytes(WIRE_NONCE_BYTES).toString("base64url");
		this.nonces.set(nonce, nowMs + this.nonceTtlMs);
		return {
			type: "enroll-owner",
			domainId,
			routerAddr,
			routerSignPub: this.identity.sign.pub,
			routerBoxPub: this.identity.box.pub,
			nonce,
		};
	}

	public registerNonceCleanup(nonce: string, cleanup: () => void): void {
		this.nonceCleanups.set(nonce, cleanup);
	}

	public redeemEnrollOwner(nonce: string, ownerSignPub: string, ownerBoxPub: string, nowMs: number): string | null {
		const expiresAt = this.nonces.get(nonce);
		this.nonces.delete(nonce);
		const cleanup = this.nonceCleanups.get(nonce);
		if (cleanup) {
			this.nonceCleanups.delete(nonce);
			try {
				cleanup();
			} catch {}
		}
		if (expiresAt === undefined) return "unknown or already-redeemed enrollment nonce";
		if (nowMs > expiresAt) return "enrollment nonce expired";
		if (this.state.ownerSignPub && this.state.ownerSignPub !== ownerSignPub) {
			return "Domain already rooted at a different owner";
		}
		this.state.ownerSignPub = ownerSignPub;
		this.state.ownerBoxPub = ownerBoxPub;
		this.store.save(this.state);
		return null;
	}

	public admit(signed: SignedAdmission): string | null {
		if (!this.state.ownerSignPub) return "Domain not rooted";
		if (!verifyAdmission(signed, this.state.ownerSignPub)) return "admission not owner-signed";
		const a = signed.admission;
		if (a.kind === "gateway" && !a.gatewayId) return "gateway admission missing gatewayId";
		if (a.kind === "console" && a.gatewayId) return "console admission must not carry a gatewayId";
		const dup = this.state.admissions.some(
			(s) => s.admission.signPub === a.signPub && s.admission.nonce === a.nonce,
		);
		if (dup) return null;
		this.state.admissions.push(signed);
		this.store.save(this.state);
		return null;
	}

	public revoke(signed: SignedRevocation): string | null {
		if (!this.state.ownerSignPub) return "Domain not rooted";
		if (!verifyRevocation(signed, this.state.ownerSignPub)) return "revocation not owner-signed";
		this.state.revocations.push(signed);
		this.store.save(this.state);
		return null;
	}

	public addLinkEdge(signed: SignedXDomainLinkEdge): string | null {
		if (!this.state.ownerSignPub) return "Domain not rooted";
		if (!verifyXDomainLinkEdge(signed, this.state.ownerSignPub)) return "link edge not owner-signed";
		if (signed.edge.srcDomainId !== this.domainId) return "link edge srcDomainId does not match this Domain";
		if (!this.state.linkEdges) this.state.linkEdges = [];
		const dup = this.state.linkEdges.some(
			(e) => e.edge.srcDomainId === signed.edge.srcDomainId && e.edge.nonce === signed.edge.nonce,
		);
		if (dup) return null;
		const nullified = (this.state.linkRevocations ?? []).some(
			(r) =>
				r.revocation.srcDomainId === signed.edge.srcDomainId &&
				r.revocation.dstDomainId === signed.edge.dstDomainId &&
				verifyXDomainLinkRevocation(r, this.state.ownerSignPub as string) &&
				r.revocation.revokedAt >= signed.edge.issuedAt,
		);
		if (nullified) return null;
		this.state.linkEdges.push(signed);
		this.store.save(this.state);
		return null;
	}

	public removeLinkEdge(signed: SignedXDomainLinkRevocation): string | null {
		if (!this.state.ownerSignPub) return "Domain not rooted";
		if (!verifyXDomainLinkRevocation(signed, this.state.ownerSignPub)) return "revocation not owner-signed";
		const rev = signed.revocation;
		if (rev.srcDomainId !== this.domainId) return "revocation srcDomainId does not match this Domain";
		if (!this.state.linkRevocations) this.state.linkRevocations = [];
		const dup = this.state.linkRevocations.some(
			(r) =>
				r.revocation.srcDomainId === rev.srcDomainId &&
				r.revocation.dstDomainId === rev.dstDomainId &&
				r.revocation.nonce === rev.nonce,
		);
		if (!dup) this.state.linkRevocations.push(signed);
		if (this.state.linkEdges) {
			this.state.linkEdges = this.state.linkEdges.filter(
				(e) =>
					!(
						e.edge.srcDomainId === rev.srcDomainId &&
						e.edge.dstDomainId === rev.dstDomainId &&
						e.edge.issuedAt <= rev.revokedAt
					),
			);
		}
		this.store.save(this.state);
		return null;
	}

	public hasLinkEdge(srcDomainId: string, dstDomainId: string): boolean {
		if (!this.state.ownerSignPub) return false;
		let newest: number | null = null;
		for (const s of this.state.linkEdges ?? []) {
			if (s.edge.srcDomainId !== srcDomainId || s.edge.dstDomainId !== dstDomainId) continue;
			if (!verifyXDomainLinkEdge(s, this.state.ownerSignPub)) continue;
			if (newest === null || s.edge.issuedAt > newest) newest = s.edge.issuedAt;
		}
		if (newest === null) return false;
		for (const r of this.state.linkRevocations ?? []) {
			if (r.revocation.srcDomainId !== srcDomainId || r.revocation.dstDomainId !== dstDomainId) continue;
			if (!verifyXDomainLinkRevocation(r, this.state.ownerSignPub)) continue;
			if (r.revocation.revokedAt >= newest) return false;
		}
		return true;
	}

	public linkEdgeId(srcDomainId: string, dstDomainId: string): string | null {
		if (!this.hasLinkEdge(srcDomainId, dstDomainId) || !this.state.ownerSignPub) return null;
		const edge = (this.state.linkEdges ?? [])
			.filter(
				(s) =>
					s.edge.srcDomainId === srcDomainId &&
					s.edge.dstDomainId === dstDomainId &&
					verifyXDomainLinkEdge(s, this.state.ownerSignPub as string),
			)
			.sort((a, b) => b.edge.issuedAt - a.edge.issuedAt)[0];
		return edge?.signature ?? null;
	}

	public getDomainSnapshot(): DomainSnapshot | null {
		if (!this.state.ownerSignPub) return null;
		return {
			ownerSignPub: this.state.ownerSignPub,
			admissions: this.state.admissions,
			revocations: this.state.revocations,
			displayName: this.state.displayName ?? null,
		};
	}

	public getDomainStatus(): DomainStatus {
		if (this.state.ownerSignPub) return "rooted";
		if (this.state.pendingTenant) return "pending";
		return "unrooted";
	}

	public get displayName(): string | null {
		return this.state.displayName ?? this.state.pendingTenant?.displayName ?? null;
	}
}

////////////////////////////////
//  Functions & Helpers

export type EnrollRoute =
	| { kind: "domain"; domainId: string }
	| { kind: "tenant-authority" }
	| { kind: "refused"; error: string };

export interface EnrollRouteDeps {
	adminDomainId: string | null;

	rootedDomainFor: (ownerSignPub: string) => string | null;
}

export function resolveEnrollRoute(op: EnrollOp, deps: EnrollRouteDeps): EnrollRoute {
	switch (op.kind) {
		case "submit_admission": {
			const domainId = deps.rootedDomainFor(op.admission.ownerSignPub);
			return domainId ? { kind: "domain", domainId } : { kind: "refused", error: "admission not owner-signed" };
		}
		case "submit_revocation": {
			const domainId = deps.rootedDomainFor(op.revocation.ownerSignPub);
			return domainId ? { kind: "domain", domainId } : { kind: "refused", error: "revocation not owner-signed" };
		}
		case "submit_xdomain_link":
			return { kind: "domain", domainId: op.edge.edge.srcDomainId };
		case "revoke_xdomain_link":
			return { kind: "domain", domainId: op.revocation.revocation.srcDomainId };
		case "delete_domain":
			return { kind: "tenant-authority" };
		case "enroll_redeem":
		case "provision_tenant":
		case "remove_tenant":
		case "set_display_name":
			return deps.adminDomainId
				? { kind: "domain", domainId: deps.adminDomainId }
				: { kind: "refused", error: "no admin Domain" };
	}
}

export function dispatchEnrollOp(
	c: EnrollmentCoordinator,
	op: EnrollOp,
	tenant?: TenantAdmin | null,
): EnrollResult | Promise<EnrollResult> {
	let err: string | null;
	switch (op.kind) {
		case "enroll_redeem":
			return { ok: false, error: "enroll_redeem is retired" };
		case "submit_admission":
			err = c.admit(op.admission);
			break;
		case "submit_revocation":
			err = c.revoke(op.revocation);
			break;
		case "submit_xdomain_link":
			err = c.addLinkEdge(op.edge);
			break;
		case "revoke_xdomain_link":
			err = c.removeLinkEdge(op.revocation);
			break;
		case "provision_tenant":
			if (!tenant) return { ok: false, error: "tenant administration not available" };
			return tenant.provisionTenant(op.provision);
		case "remove_tenant":
			if (!tenant) return { ok: false, error: "tenant administration not available" };
			return tenant.removeTenant(op.removal);
		case "set_display_name":
			if (!tenant) return { ok: false, error: "tenant administration not available" };
			return tenant.setDisplayName(op.rename);
		case "delete_domain":
			if (!tenant) return { ok: false, error: "tenant administration not available" };
			return tenant.deleteDomain(op.deletion);
	}
	return err ? { ok: false, error: err } : { ok: true };
}

export function inMemoryEnrollmentStore(initial?: EnrollmentState): EnrollmentStore {
	let saved: EnrollmentState | null = initial ?? null;
	return {
		load: () => saved,
		save: (state) => {
			saved = structuredClone(state);
		},
	};
}
