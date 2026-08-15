import type { SignedAdmission, SignedRevocation } from "../shared/admission.js";
import type { Identity } from "../shared/crypto.js";
import type { SignedXDomainLinkEdge, SignedXDomainLinkRevocation } from "../shared/federation-lifecycle.js";

////////////////////////////////
//  Interfaces & Types

export const FEDERATION_SECRET_SCHEMA = 2;

export interface SeenAdminNonce {
	nonce: string;
	at: number;
}

export interface EnrollmentState {
	ownerSignPub: string | null;
	ownerBoxPub: string | null;
	admissions: SignedAdmission[];
	revocations: SignedRevocation[];
	linkEdges?: SignedXDomainLinkEdge[];
	linkRevocations?: SignedXDomainLinkRevocation[];
	displayName?: string | null;
	pendingTenant?: PendingTenantRecord;
	isAdminDomain?: boolean;
}

export interface PendingTenantRecord {
	displayName: string;
	nonce: string;
	issuedAt: number;
	ttlMs: number;
	rooted: boolean;
}

export interface EnrollmentStore {
	load(): EnrollmentState | null;
	save(state: EnrollmentState): void;
}

export interface FederationSecret {
	schema?: number;
	identity: Identity;
	enrollment: Record<string, EnrollmentState>;
	seenAdminNonces?: SeenAdminNonce[];
}

////////////////////////////////
//  Functions & Helpers

export function migrateSecret(raw: FederationSecret): FederationSecret {
	return {
		schema: FEDERATION_SECRET_SCHEMA,
		identity: raw.identity,
		enrollment: raw.enrollment ?? {},
		seenAdminNonces: raw.seenAdminNonces ?? [],
	};
}
