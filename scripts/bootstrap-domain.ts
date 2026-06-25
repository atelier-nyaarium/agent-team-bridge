// Admin Domain seating for the owner setup flow.
//
// Phone-anchored trust: the owner root keypair is generated SILENTLY on the Console and never
// reaches the host. So the host never holds, prompts for, or roots with the owner key. Instead the
// trusted host bootstrap (it has direct Secret access) PRE-STAGES the admin Domain as a PENDING
// tenant - an displayName label plus a one-time invite nonce, no owner root - and the admin's
// phone first-roots it on scan, exactly like a friend. `pendingAdminDomain` builds that pending
// slice.
//
// Preserves evie's own identity verbatim (seating must not change evie's SAS).
//
// Multi-tenant: evie's federation Secret is the v2 multi-domain shape
// (`{ schema:2, identity, enrollment: { <domainId>: state } }`) hosting OTHER owners' Domains. Setup
// touches only the ADMIN Domain, so the v2 Secret is read, the admin slice is replaced in place, and the
// WHOLE map is written back - never clobbering a friend Domain or dropping the admin Domain's admissions.
//
// The persisted shapes mirror evie's EnrollmentState / PendingTenantRecord byte-for-byte: the host
// writes the Secret evie reads, so a drift here would make evie reject the admin slice.

import type { SignedAdmission, SignedRevocation } from "../src/shared/admission.js";
import type { Identity } from "../src/shared/crypto.js";

////////////////////////////////
//  Interfaces & Types

/** A pending-tenant record on a not-yet-rooted Domain (an displayName display label + a
 * one-time invite nonce, no owner). Mirrors evie's `PendingTenantRecord` exactly (the wire
 * `PendingTenant` shape minus its `domainId`, which is the enrollment map key); the host writes
 * what evie reads. The friend's first_root spends the nonce and flips `rooted` true. */
export interface PendingTenantRecord {
	displayName: string;
	nonce: string;
	issuedAt: number;
	ttlMs: number;
	rooted: boolean;
}

/** One Domain's slice (a v2 per-domain entry). `ownerSignPub`/`ownerBoxPub` are null on a
 * pending slice (no owner has rooted it yet) and set once rooted. `displayName` is the owner's
 * display name; `pendingTenant` marks a Domain pre-staged but not yet rooted. Mirrors evie's
 * `EnrollmentState` for the fields setup writes. */
interface DomainEnrollment {
	ownerSignPub: string | null;
	ownerBoxPub: string | null;
	admissions: SignedAdmission[];
	revocations: SignedRevocation[];
	displayName?: string | null;
	pendingTenant?: PendingTenantRecord;
	// Marks the admin's own Domain so evie scopes the console relay to it. Only the admin
	// slice this script writes carries it; a hosted guest Domain never does.
	isAdminDomain?: boolean;
}

/** The multi-tenant (v2) Secret: `enrollment` is a domainId -> state map and a numeric
 * `schema` marker is present. */
interface MultiDomainEvieFederation {
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
 * `pendingTenant` discriminator and the admin's phone first-roots on scan. */
export interface PendingResult {
	federationJson: MultiDomainFederationJson;
}

const FEDERATION_SECRET_SCHEMA = 2;

////////////////////////////////
//  Functions & Helpers

/** Parse the live evie federation.json and pull out evie's identity, both validated with an
 * actionable message (not a raw SyntaxError). The identity is preserved verbatim by every write
 * path so seating never re-mints evie's keypair (which would change its SAS fingerprint). */
function readEvieFederation(evieFedJson: string): {
	evieFed: MultiDomainEvieFederation;
	evieIdentity: Identity;
} {
	let evieFed: MultiDomainEvieFederation;
	try {
		evieFed = JSON.parse(evieFedJson) as MultiDomainEvieFederation;
	} catch {
		throw new Error(
			"evie federation Secret is not valid JSON - check `kubectl get secret evie-federation -o json`",
		);
	}
	const evieIdentity = evieFed.identity;
	if (!evieIdentity?.sign?.pub || !evieIdentity?.box?.pub) {
		throw new Error("evie federation Secret has no usable identity (.identity.sign/.box)");
	}
	return { evieFed, evieIdentity };
}

/** The incumbent admin Domain slice from the v2 map. Undefined when the admin Domain is unset. */
function adminSliceOf(
	evieFed: MultiDomainEvieFederation,
	adminDomainId: string,
): Partial<DomainEnrollment> | undefined {
	return evieFed.enrollment?.[adminDomainId];
}

/** Normalize a non-admin Domain slice to the full shape so the written map is well-formed, while
 * carrying every field (including a friend Domain's displayName + pendingTenant) through
 * untouched. Setup only ever rewrites the admin slice; a friend Domain must survive verbatim. */
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
 * back: every other Domain is carried untouched and the whole map is written back with the v2
 * marker, so a friend Domain and the admin Domain's own admissions survive. */
function composeFederationJson(
	evieFed: MultiDomainEvieFederation,
	evieIdentity: Identity,
	adminSlice: DomainEnrollment,
	adminDomainId: string,
): MultiDomainFederationJson {
	const incumbent = evieFed.enrollment ?? {};
	const enrollment: Record<string, DomainEnrollment> = {};
	for (const [domainId, slice] of Object.entries(incumbent)) {
		if (domainId === adminDomainId) continue;
		enrollment[domainId] = carryOtherDomain(slice);
	}
	enrollment[adminDomainId] = adminSlice;
	return { schema: FEDERATION_SECRET_SCHEMA, identity: evieIdentity, enrollment };
}

/** Build the PENDING admin slice: an displayName label + a one-time invite nonce, NO owner root.
 * The fresh setup writes this so the admin's phone first-roots the admin Domain on scan, exactly
 * like a friend. Mirrors evie's pending slice (`{ ownerSignPub: null, ownerBoxPub: null, admissions:
 * [], revocations: [], displayName, pendingTenant }`) so evie reads it back without complaint. The
 * nonce is minted by the caller (standard base64, never base64url - the wire `nonce` is a b64Field). */
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

/** Pre-stage the admin Domain as a PENDING tenant in evie's Secret, preserving evie's identity +
 * every friend Domain. `evieFedJson` is the live evie federation.json text. The caller mints the
 * one-time invite `nonce` (standard base64) and emits it in the blob's `pendingTenant` so the
 * admin's phone first-roots on scan. This is the fresh-setup path: there is no owner key to
 * root with (it is generated silently on the phone), so the admin slice is rootless until the
 * first_root lands. */
export function pendingAdminDomain(
	evieFedJson: string,
	adminDomainId: string,
	displayName: string,
	nonce: string,
	issuedAt: number,
	ttlMs: number,
): PendingResult {
	const { evieFed, evieIdentity } = readEvieFederation(evieFedJson);
	const adminSlice = pendingAdminSlice(displayName, nonce, issuedAt, ttlMs);
	return { federationJson: composeFederationJson(evieFed, evieIdentity, adminSlice, adminDomainId) };
}

/** Inspect the incumbent admin Domain slice to drive the fresh-vs-reprovision state machine.
 * `rooted` is true once an owner key is set (re-provision: emit the blob only). `ownerSignPub` is
 * that rooted owner key (so a re-provision can sanity-check a gateway's pinned owner against it).
 * `displayName` is the owner's display name if any (preserved across a re-provision). A malformed
 * Secret reads as a fresh, unrooted admin Domain (so setup pre-stages it) rather than throwing here. */
export function readAdminDomain(
	evieFedJson: string,
	adminDomainId: string,
): {
	rooted: boolean;
	ownerSignPub: string | null;
	displayName: string | null;
} {
	let evieFed: MultiDomainEvieFederation;
	try {
		evieFed = JSON.parse(evieFedJson) as MultiDomainEvieFederation;
	} catch {
		return { rooted: false, ownerSignPub: null, displayName: null };
	}
	const adminSlice = adminSliceOf(evieFed, adminDomainId);
	const ownerSignPub = adminSlice?.ownerSignPub ?? null;
	const displayName = adminSlice?.displayName ?? adminSlice?.pendingTenant?.displayName ?? null;
	return { rooted: ownerSignPub != null, ownerSignPub, displayName };
}

////////////////////////////////
//  Purge helpers (evie-side deletes for the setup-menu purges)
//
//  Both operate on the RAW parsed Secret JSON and mutate only the target Domain, then re-serialize.
//  This is lossless: every untouched field of the target slice and every other Domain (including
//  fields the setup write paths never carry - linkEdges, linkRevocations, isAdminDomain) survive
//  verbatim, unlike composeFederationJson which only carries a known field subset.

/** The v2 Secret as raw structure for a purge mutation: evie persists v2, so the enrollment is a
 * domainId -> slice map. Slices are opaque here (the mutation only reads admissions/kind/gatewayId);
 * everything else passes through untouched. */
interface RawFederation {
	schema?: number;
	identity?: unknown;
	enrollment?: Record<string, RawDomainSlice>;
}

interface RawDomainSlice {
	admissions?: Array<{ admission?: { kind?: string; gatewayId?: string } }>;
	[k: string]: unknown;
}

/** Drop a gateway's admission from one Domain's allowlist (purge gateway). Removes only
 * `kind:"gateway"` entries whose `gatewayId` matches; console admissions, other gateways,
 * revocations, and every other field of the slice and of other Domains are untouched. Idempotent
 * when the Domain or the gateway id is absent. */
export function removeGatewayAdmission(evieFedJson: string, domainId: string, gatewayId: string): string {
	const fed = JSON.parse(evieFedJson) as RawFederation;
	const slice = fed.enrollment?.[domainId];
	if (!slice) return evieFedJson;
	if (Array.isArray(slice.admissions)) {
		slice.admissions = slice.admissions.filter(
			(a) => !(a?.admission?.kind === "gateway" && a.admission.gatewayId === gatewayId),
		);
	}
	return JSON.stringify(fed);
}

/** Drop a whole Domain from the Secret (purge federation), keeping evie's identity and every other
 * Domain verbatim so a hosted friend tenant survives. Idempotent when the Domain is absent. */
export function removeDomain(evieFedJson: string, domainId: string): string {
	const fed = JSON.parse(evieFedJson) as RawFederation;
	if (fed.enrollment) delete fed.enrollment[domainId];
	return JSON.stringify(fed);
}
