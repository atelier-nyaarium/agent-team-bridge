// Admin Domain seating for the owner setup flow.
//
// The owner root keypair is generated on the Console and never reaches the host, so the host
// pre-stages the admin Domain as a pending tenant (a displayName label plus a one-time invite
// nonce, no owner root) and the admin's phone first-roots it on scan like any friend.
//
// The Router's identity is preserved verbatim by every write path, since re-minting it would change
// the SAS fingerprint every enrolled device holds. The state file is the v2 multi-domain shape
// (`{ schema:2, identity, enrollment: { <domainId>: state } }`); setup touches only the admin
// slice and writes the whole map back so a friend Domain is never clobbered.
//
// Persisted shapes mirror the Router's EnrollmentState / PendingTenantRecord byte-for-byte
// (src/federation-server/federationSecret.ts): the host writes the file the Router reads, so any
// drift makes the Router reject the admin slice.

import type { SignedAdmission, SignedRevocation } from "../src/shared/admission.js";
import type { Identity } from "../src/shared/crypto.js";

////////////////////////////////
//  Interfaces & Types

/** A pending-tenant record on a not-yet-rooted Domain. Mirrors the Router's `PendingTenantRecord`
 * exactly (the wire `PendingTenant` shape minus its `domainId`, which is the enrollment map key).
 * The friend's first_root spends the nonce and flips `rooted` true. */
export interface PendingTenantRecord {
	displayName: string;
	nonce: string;
	issuedAt: number;
	ttlMs: number;
	rooted: boolean;
}

/** One Domain's slice (a v2 per-domain entry). `ownerSignPub`/`ownerBoxPub` are null on a pending
 * slice and set once rooted. Mirrors the Router's `EnrollmentState` for the fields setup writes. */
interface DomainEnrollment {
	ownerSignPub: string | null;
	ownerBoxPub: string | null;
	admissions: SignedAdmission[];
	revocations: SignedRevocation[];
	displayName?: string | null;
	pendingTenant?: PendingTenantRecord;
	// Marks the admin's own Domain so the Router scopes the console relay to it. Only the admin slice
	// this script writes carries it; a hosted guest Domain never does.
	isAdminDomain?: boolean;
}

/** The multi-tenant (v2) Secret: `enrollment` is a domainId -> state map and a numeric
 * `schema` marker is present. */
interface MultiDomainRouterFederation {
	schema?: number;
	identity?: Identity;
	enrollment?: Record<string, Partial<DomainEnrollment>>;
}

/** The v2 federation.json this script writes back: the WHOLE domain map with only the admin
 * slice replaced. */
interface MultiDomainFederationJson {
	schema: number;
	identity: Identity;
	enrollment: Record<string, DomainEnrollment>;
}

/** A fresh pending setup: no `ownerSignPub` yet, so the caller emits the blob with a
 * `pendingTenant` discriminator for the phone to first-root on scan. */
export interface PendingResult {
	federationJson: MultiDomainFederationJson;
}

const FEDERATION_SECRET_SCHEMA = 2;

////////////////////////////////
//  Functions & Helpers

/** Parse the Router's federation.json and pull out its identity, with an actionable error instead
 * of a raw SyntaxError. */
function readRouterFederation(routerFedJson: string): {
	routerFed: MultiDomainRouterFederation;
	routerIdentity: Identity;
} {
	let routerFed: MultiDomainRouterFederation;
	try {
		routerFed = JSON.parse(routerFedJson) as MultiDomainRouterFederation;
	} catch {
		throw new Error(
			"the Router's federation.json is not valid JSON - restore it from ./backup-federation.sh's archive",
		);
	}
	const routerIdentity = routerFed.identity;
	if (!routerIdentity?.sign?.pub || !routerIdentity?.box?.pub) {
		throw new Error("the Router's federation.json has no usable identity (.identity.sign/.box)");
	}
	return { routerFed, routerIdentity };
}

/** The incumbent admin Domain slice from the v2 map. Undefined when the admin Domain is unset. */
function adminSliceOf(
	routerFed: MultiDomainRouterFederation,
	adminDomainId: string,
): Partial<DomainEnrollment> | undefined {
	return routerFed.enrollment?.[adminDomainId];
}

/** Normalize a non-admin Domain slice to the full shape, carrying every field through untouched.
 * Setup only rewrites the admin slice; a friend Domain must survive verbatim. */
function carryOtherDomain(slice: Partial<DomainEnrollment> | undefined): DomainEnrollment {
	return {
		ownerSignPub: slice?.ownerSignPub ?? null,
		ownerBoxPub: slice?.ownerBoxPub ?? null,
		admissions: slice?.admissions ?? [],
		revocations: slice?.revocations ?? [],
		...(slice?.displayName !== undefined ? { displayName: slice.displayName } : {}),
		...(slice?.pendingTenant !== undefined ? { pendingTenant: slice.pendingTenant } : {}),
	};
}

/** Replace the admin slice in the incumbent v2 Secret and produce the federation.json to write
 * back, carrying every other Domain untouched so a friend Domain survives. */
function composeFederationJson(
	routerFed: MultiDomainRouterFederation,
	routerIdentity: Identity,
	adminSlice: DomainEnrollment,
	adminDomainId: string,
): MultiDomainFederationJson {
	const incumbent = routerFed.enrollment ?? {};
	const enrollment: Record<string, DomainEnrollment> = {};
	for (const [domainId, slice] of Object.entries(incumbent)) {
		if (domainId === adminDomainId) continue;
		enrollment[domainId] = carryOtherDomain(slice);
	}
	enrollment[adminDomainId] = adminSlice;
	return { schema: FEDERATION_SECRET_SCHEMA, identity: routerIdentity, enrollment };
}

/** Build the pending admin slice: a displayName label + a one-time invite nonce, no owner root.
 * Mirrors the Router's pending slice so it reads it back without complaint. The caller mints the
 * nonce as standard base64, never base64url, since the wire `nonce` is a b64Field. */
function pendingAdminSlice(displayName: string, nonce: string, issuedAt: number, ttlMs: number): DomainEnrollment {
	return {
		ownerSignPub: null,
		ownerBoxPub: null,
		admissions: [],
		revocations: [],
		displayName,
		pendingTenant: { displayName, nonce, issuedAt, ttlMs, rooted: false },
		isAdminDomain: true,
	};
}

/** Pre-stage the admin Domain as a pending tenant in the Router's Secret, preserving its identity and
 * every friend Domain. `routerFedJson` is the live Router federation.json text. The owner key is
 * generated on the phone, so the admin slice stays rootless until the phone's first_root lands. */
export function pendingAdminDomain(
	routerFedJson: string,
	adminDomainId: string,
	displayName: string,
	nonce: string,
	issuedAt: number,
	ttlMs: number,
): PendingResult {
	const { routerFed, routerIdentity } = readRouterFederation(routerFedJson);
	const adminSlice = pendingAdminSlice(displayName, nonce, issuedAt, ttlMs);
	return { federationJson: composeFederationJson(routerFed, routerIdentity, adminSlice, adminDomainId) };
}

/** Inspect the incumbent admin Domain slice to drive the fresh-vs-reprovision state machine.
 * `rooted` is true once an owner key is set. A malformed Secret reads as a fresh, unrooted admin
 * Domain rather than throwing, so setup pre-stages it. */
export function readAdminDomain(
	routerFedJson: string,
	adminDomainId: string,
): {
	rooted: boolean;
	ownerSignPub: string | null;
	displayName: string | null;
} {
	let routerFed: MultiDomainRouterFederation;
	try {
		routerFed = JSON.parse(routerFedJson) as MultiDomainRouterFederation;
	} catch {
		return { rooted: false, ownerSignPub: null, displayName: null };
	}
	const adminSlice = adminSliceOf(routerFed, adminDomainId);
	const ownerSignPub = adminSlice?.ownerSignPub ?? null;
	const displayName = adminSlice?.displayName ?? adminSlice?.pendingTenant?.displayName ?? null;
	return { rooted: ownerSignPub != null, ownerSignPub, displayName };
}

////////////////////////////////
//  Purge helpers (Router-side deletes for the setup-menu purges)
//
//  Both operate on the raw parsed Secret JSON and mutate only the target Domain, then re-serialize.
//  This is lossless: every untouched field of the target slice and every other Domain (including
//  fields the setup write paths never carry, like linkEdges and isAdminDomain) survives verbatim,
//  unlike composeFederationJson which only carries a known field subset.

/** The v2 Secret as raw structure for a purge mutation. Slices are opaque here: the mutation only
 * reads admissions/kind/gatewayId, and everything else passes through untouched. */
interface RawFederation {
	schema?: number;
	identity?: unknown;
	enrollment?: Record<string, RawDomainSlice>;
}

interface RawDomainSlice {
	admissions?: Array<{ admission?: { kind?: string; gatewayId?: string } }>;
	isAdminDomain?: boolean;
	[k: string]: unknown;
}

/** Whether the Router's state holds a slice for this Domain at all, so a purge can tell "removed"
 * from "was already gone" instead of reporting the first for both. */
export function hasDomain(routerFedJson: string, domainId: string): boolean {
	const fed = JSON.parse(routerFedJson) as RawFederation;
	return fed.enrollment?.[domainId] !== undefined;
}

/** The admin Domain the Router itself marks (`isAdminDomain`, set when Router Setup stages it and
 * carried forward by the Router's own store), or null when none is. This is how a purge finds the
 * Domain when `.env` has lost `FEDERATION_DOMAIN_ID` - which the old purges did to it - since an
 * absent key says nothing about what the Router still holds. */
export function findAdminDomainId(routerFedJson: string): string | null {
	const fed = JSON.parse(routerFedJson) as RawFederation;
	for (const [domainId, slice] of Object.entries(fed.enrollment ?? {})) {
		if (slice?.isAdminDomain === true) return domainId;
	}
	return null;
}

/** Drop a whole Domain from the Secret (purge federation), keeping the Router's identity and every other
 * Domain verbatim so a hosted friend tenant survives. Idempotent when the Domain is absent. */
export function removeDomain(routerFedJson: string, domainId: string): string {
	const fed = JSON.parse(routerFedJson) as RawFederation;
	if (fed.enrollment) delete fed.enrollment[domainId];
	return JSON.stringify(fed);
}
