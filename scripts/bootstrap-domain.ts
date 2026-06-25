// Admin Domain seating for the owner setup flow.
//
// Phone-anchored trust: the owner root keypair is generated SILENTLY on the Console and never
// reaches the host. So the host never holds, prompts for, or roots with the owner key. Instead the
// trusted host bootstrap (it has direct Secret access) PRE-STAGES the admin Domain as a PENDING
// tenant - an displayName label plus a one-time invite nonce, no owner root - and the admin's
// phone first-roots it on scan, exactly like a friend. `pendingAdminDomain` builds that pending
// slice. The owner-key rooting path (`bootstrapDomain`) is kept for any caller that already holds
// the public keys (a same-owner re-root from a backed-up key); it mints nothing and signs nothing.
//
// Both preserve evie's own identity verbatim (seating must not change evie's SAS). On the rooting
// path, prior admissions / revocations + the displayName are kept ONLY when re-rooting at the SAME
// owner key; a DIFFERENT owner key starts a fresh Domain (old admissions were signed by a key that
// no longer verifies).
//
// Multi-tenant aware: evie's federation Secret may already be the v2 multi-domain shape
// (`{ schema:2, identity, enrollment: { <domainId>: state } }`) hosting OTHER owners' Domains. Setup
// touches only the ADMIN Domain, so a v2 Secret is read, the admin slice is replaced in place, and the
// WHOLE map is written back - never clobbering a friend Domain or dropping the admin Domain's admissions. A
// legacy v1 Secret (`{ identity, enrollment: <state> }`) keeps the original single-Domain write path.
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

/** One Domain's slice (a v2 per-domain entry, and the v1 single-Domain `enrollment` payload -
 * the two shapes share this object). `ownerSignPub`/`ownerBoxPub` are null on a pending slice
 * (no owner has rooted it yet) and set once rooted. `displayName` is the friendly network
 * label; `pendingTenant` marks a Domain pre-staged but not yet rooted. Mirrors evie's
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

/** The legacy (v1) single-Domain Secret: `enrollment` IS one EnrollmentState. */
interface LegacyEvieFederation {
	identity?: Identity;
	enrollment?: Partial<DomainEnrollment>;
}

/** The multi-tenant (v2) Secret: `enrollment` is a domainId -> state map and a numeric
 * `schema` marker is present (or inferable from the map shape). */
interface MultiDomainEvieFederation {
	schema?: number;
	identity?: Identity;
	enrollment?: Record<string, Partial<DomainEnrollment>>;
}

/** The v1 federation.json this script writes for a legacy / first-root Secret. */
interface LegacyFederationJson {
	identity: Identity;
	enrollment: DomainEnrollment;
}

/** The v2 federation.json this script writes back when the incumbent Secret is
 * multi-tenant: the WHOLE domain map with only the admin slice replaced. */
interface MultiDomainFederationJson {
	schema: number;
	identity: Identity;
	enrollment: Record<string, DomainEnrollment>;
}

export interface BootstrapResult {
	ownerSignPub: string;
	// Serialized verbatim by the caller into the Secret's `federation.json`. v1 for a
	// legacy / first-root Secret, v2 for an already multi-tenant one.
	federationJson: LegacyFederationJson | MultiDomainFederationJson;
}

/** A fresh pending setup: no `ownerSignPub` yet, so the caller emits the blob with a
 * `pendingTenant` discriminator and the admin's phone first-roots on scan. */
export interface PendingResult {
	federationJson: LegacyFederationJson | MultiDomainFederationJson;
}

const FEDERATION_SECRET_SCHEMA = 2;

////////////////////////////////
//  Functions & Helpers

/** Validate a raw-32-byte key (base64). Rejects a typo/garbage owner key here, where the error is
 * actionable, instead of letting it root evie and then fail silently everywhere (a malformed key
 * filters out every admission downstream). */
function assertKey(label: string, value: string): string {
	if (Buffer.from(value, "base64").length !== 32) {
		throw new Error(`${label} is not a base64-encoded 32-byte key - re-copy it from the Console's Owner setup`);
	}
	return value;
}

/** True when the incumbent Secret is the multi-tenant (v2) shape: an explicit numeric
 * `schema` marker, OR a map-valued `enrollment` that is NOT itself an EnrollmentState
 * (it carries no top-level ownerSignPub/admissions/revocations, so its values are
 * per-domain slices). Recognizes the same v2 shapes evie's KubeSecretStore
 * `isMultiDomain` does for the cases that occur on a live Secret. The two deliberately
 * differ on a no-`schema` empty/absent enrollment (evie treats it as a fresh
 * multi-domain map; this returns legacy first-root) - unreachable here because evie's
 * init() always writes the `schema` marker before this script reads the Secret, so the
 * live flow always takes the `schema` branch. */
function isMultiDomain(fed: LegacyEvieFederation | MultiDomainEvieFederation): fed is MultiDomainEvieFederation {
	if (typeof (fed as MultiDomainEvieFederation).schema === "number") return true;
	const enrollment = (fed as { enrollment?: unknown }).enrollment;
	if (!enrollment || typeof enrollment !== "object") return false; // absent/empty: treat as a legacy first-root
	const looksLikeState = "ownerSignPub" in enrollment || "admissions" in enrollment || "revocations" in enrollment;
	return !looksLikeState;
}

/** Parse the live evie federation.json and pull out evie's identity, both validated with an
 * actionable message (not a raw SyntaxError). The identity is preserved verbatim by every write
 * path so seating never re-mints evie's keypair (which would change its SAS fingerprint). */
function readEvieFederation(evieFedJson: string): {
	evieFed: LegacyEvieFederation | MultiDomainEvieFederation;
	evieIdentity: Identity;
} {
	let evieFed: LegacyEvieFederation | MultiDomainEvieFederation;
	try {
		evieFed = JSON.parse(evieFedJson) as LegacyEvieFederation | MultiDomainEvieFederation;
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

/** The incumbent admin Domain slice from either Secret shape: the admin entry of a v2 map, or the
 * single `enrollment` state of a legacy v1 Secret. Undefined when the admin Domain is unset. */
function adminSliceOf(
	evieFed: LegacyEvieFederation | MultiDomainEvieFederation,
	adminDomainId: string,
): Partial<DomainEnrollment> | undefined {
	return isMultiDomain(evieFed) ? evieFed.enrollment?.[adminDomainId] : (evieFed as LegacyEvieFederation).enrollment;
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

/** Replace the admin slice in the incumbent Secret and produce the federation.json to write back,
 * handling both shapes: a v2 Secret keeps every other Domain (carried untouched) and writes the
 * whole map back with the v2 marker; a legacy v1 Secret keeps the single-Domain write. A blind v1
 * overwrite of a v2 Secret would obliterate every non-admin Domain (data loss, P5). */
function composeFederationJson(
	evieFed: LegacyEvieFederation | MultiDomainEvieFederation,
	evieIdentity: Identity,
	adminSlice: DomainEnrollment,
	adminDomainId: string,
): LegacyFederationJson | MultiDomainFederationJson {
	if (isMultiDomain(evieFed)) {
		const incumbent = evieFed.enrollment ?? {};
		const enrollment: Record<string, DomainEnrollment> = {};
		for (const [domainId, slice] of Object.entries(incumbent)) {
			if (domainId === adminDomainId) continue;
			enrollment[domainId] = carryOtherDomain(slice);
		}
		enrollment[adminDomainId] = adminSlice;
		return { schema: FEDERATION_SECRET_SCHEMA, identity: evieIdentity, enrollment };
	}
	return { identity: evieIdentity, enrollment: adminSlice };
}

/** Build the rooted admin slice from the incumbent admin state. Keeps the existing allowlist +
 * displayName only when re-rooting at the SAME owner; a different owner key is a fresh Domain
 * (prior admissions would not verify under it, and its displayName was the prior owner's label,
 * so both are dropped).
 *
 * OFF the default provision() path: that path pre-stages a PENDING admin Domain (the phone first-roots on
 * scan) and, on a re-provision of an already-rooted admin Domain, never rewrites the Secret at all - so the
 * live re-provision preserves displayName by NOT TOUCHING the slice, not through this helper. This
 * helper serves the owner-key-in-hand rooting case only (`bootstrapDomain`). */
function rootAdminSlice(
	prior: Partial<DomainEnrollment> | undefined,
	ownerSignPub: string,
	ownerBoxPub: string,
): DomainEnrollment {
	const sameOwner = prior?.ownerSignPub === ownerSignPub;
	return {
		ownerSignPub,
		ownerBoxPub,
		admissions: sameOwner ? (prior?.admissions ?? []) : [],
		revocations: sameOwner ? (prior?.revocations ?? []) : [],
		...(sameOwner && prior?.displayName != null ? { displayName: prior.displayName } : {}),
		isAdminDomain: true,
	};
}

/** Root evie's Domain at the owner's public keys, preserving evie's identity. `evieFedJson` is the
 * live evie federation.json text; the owner keys are base64 raw-32-byte public keys.
 *
 * OFF the default provision() path: the fresh setup pre-stages a PENDING admin Domain (`pendingAdminDomain`)
 * and the admin's phone first-roots on scan, so the host never holds the owner key. This
 * owner-key-paste rooting is kept for the same-owner re-root-from-backup case (a caller that already
 * holds the public keys). It mints nothing and signs nothing.
 *
 * v2-aware: an already multi-tenant Secret is read and only its ADMIN slice is replaced, so other
 * Domains and the admin Domain's own admissions survive; the WHOLE map is written back with the v2 marker. A
 * legacy v1 Secret keeps the original single-Domain write. */
export function bootstrapDomain(
	evieFedJson: string,
	adminDomainId: string,
	ownerSignPub: string,
	ownerBoxPub: string,
): BootstrapResult {
	assertKey("owner signing key", ownerSignPub);
	assertKey("owner box key", ownerBoxPub);
	const { evieFed, evieIdentity } = readEvieFederation(evieFedJson);
	const adminSlice = rootAdminSlice(adminSliceOf(evieFed, adminDomainId), ownerSignPub, ownerBoxPub);
	return { ownerSignPub, federationJson: composeFederationJson(evieFed, evieIdentity, adminSlice, adminDomainId) };
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
 * first_root lands. v2-aware, same as `bootstrapDomain`. */
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
 * `displayName` is the network's label if any (preserved across a re-provision). A malformed
 * Secret reads as a fresh, unrooted admin Domain (so setup pre-stages it) rather than throwing here. */
export function readAdminDomain(
	evieFedJson: string,
	adminDomainId: string,
): {
	rooted: boolean;
	ownerSignPub: string | null;
	displayName: string | null;
} {
	let evieFed: LegacyEvieFederation | MultiDomainEvieFederation;
	try {
		evieFed = JSON.parse(evieFedJson) as LegacyEvieFederation | MultiDomainEvieFederation;
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
