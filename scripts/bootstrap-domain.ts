// Home Domain seating for the owner setup flow.
//
// Phone-anchored trust: the owner root keypair is generated SILENTLY on the Console and never
// reaches the host. So the host never holds, prompts for, or roots with the owner key. Instead the
// trusted host bootstrap (it has direct Secret access) PRE-STAGES the home Domain as a PENDING
// tenant - an profileName label plus a one-time invite nonce, no owner root - and the operator's
// phone first-roots it on scan, exactly like a friend. `pendingHomeDomain` builds that pending
// slice. The owner-key rooting path (`bootstrapDomain`) is kept for any caller that already holds
// the public keys (a same-owner re-root from a backed-up key); it mints nothing and signs nothing.
//
// Both preserve evie's own identity verbatim (seating must not change evie's SAS). On the rooting
// path, prior admissions / revocations + the profileName are kept ONLY when re-rooting at the SAME
// owner key; a DIFFERENT owner key starts a fresh Domain (old admissions were signed by a key that
// no longer verifies).
//
// Multi-tenant aware: evie's federation Secret may already be the v2 multi-domain shape
// (`{ schema:2, identity, enrollment: { <domainId>: state } }`) hosting OTHER owners' Domains. Setup
// touches only the HOME Domain, so a v2 Secret is read, the home slice is replaced in place, and the
// WHOLE map is written back - never clobbering a friend Domain or dropping home's admissions. A
// legacy v1 Secret (`{ identity, enrollment: <state> }`) keeps the original single-Domain write path.
//
// The persisted shapes mirror evie's EnrollmentState / PendingTenantRecord byte-for-byte: the host
// writes the Secret evie reads, so a drift here would make evie reject the home slice.

import type { SignedAdmission, SignedRevocation } from "../src/shared/admission.js";
import type { Identity } from "../src/shared/crypto.js";

////////////////////////////////
//  Interfaces & Types

/** A pending-tenant record on a not-yet-rooted Domain (an profileName display label + a
 * one-time invite nonce, no owner). Mirrors evie's `PendingTenantRecord` exactly (the wire
 * `PendingTenant` shape minus its `domainId`, which is the enrollment map key); the host writes
 * what evie reads. The friend's first_root spends the nonce and flips `rooted` true. */
export interface PendingTenantRecord {
	profileName: string;
	nonce: string;
	issuedAt: number;
	ttlMs: number;
	rooted: boolean;
}

/** One Domain's slice (a v2 per-domain entry, and the v1 single-Domain `enrollment` payload -
 * the two shapes share this object). `ownerSignPub`/`ownerBoxPub` are null on a pending slice
 * (no owner has rooted it yet) and set once rooted. `profileName` is the friendly network
 * label; `pendingTenant` marks a Domain pre-staged but not yet rooted. Mirrors evie's
 * `EnrollmentState` for the fields setup writes. */
interface DomainEnrollment {
	ownerSignPub: string | null;
	ownerBoxPub: string | null;
	admissions: SignedAdmission[];
	revocations: SignedRevocation[];
	profileName?: string | null;
	pendingTenant?: PendingTenantRecord;
	// Marks the operator's own home Domain so evie scopes the console relay to it. Only the home
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
 * multi-tenant: the WHOLE domain map with only the home slice replaced. */
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

/** A fresh pending home setup: no `ownerSignPub` yet, so the caller emits the blob with a
 * `pendingTenant` discriminator and the operator's phone first-roots on scan. */
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

/** The incumbent home Domain slice from either Secret shape: the `home` entry of a v2 map, or the
 * single `enrollment` state of a legacy v1 Secret. Undefined when home is unset. */
function homeSliceOf(
	evieFed: LegacyEvieFederation | MultiDomainEvieFederation,
	homeDomainId: string,
): Partial<DomainEnrollment> | undefined {
	return isMultiDomain(evieFed) ? evieFed.enrollment?.[homeDomainId] : (evieFed as LegacyEvieFederation).enrollment;
}

/** Normalize a non-home Domain slice to the full shape so the written map is well-formed, while
 * carrying every field (including a friend Domain's profileName + pendingTenant) through
 * untouched. Setup only ever rewrites the home slice; a friend Domain must survive verbatim. */
function carryOtherDomain(slice: Partial<DomainEnrollment> | undefined): DomainEnrollment {
	return {
		ownerSignPub: slice?.ownerSignPub ?? null,
		ownerBoxPub: slice?.ownerBoxPub ?? null,
		admissions: slice?.admissions ?? [],
		revocations: slice?.revocations ?? [],
		...(slice?.profileName !== undefined ? { profileName: slice.profileName } : {}),
		...(slice?.pendingTenant !== undefined ? { pendingTenant: slice.pendingTenant } : {}),
	};
}

/** Replace the home slice in the incumbent Secret and produce the federation.json to write back,
 * handling both shapes: a v2 Secret keeps every other Domain (carried untouched) and writes the
 * whole map back with the v2 marker; a legacy v1 Secret keeps the single-Domain write. A blind v1
 * overwrite of a v2 Secret would obliterate every non-home Domain (data loss, P5). */
function composeFederationJson(
	evieFed: LegacyEvieFederation | MultiDomainEvieFederation,
	evieIdentity: Identity,
	homeSlice: DomainEnrollment,
	homeDomainId: string,
): LegacyFederationJson | MultiDomainFederationJson {
	if (isMultiDomain(evieFed)) {
		const incumbent = evieFed.enrollment ?? {};
		const enrollment: Record<string, DomainEnrollment> = {};
		for (const [domainId, slice] of Object.entries(incumbent)) {
			if (domainId === homeDomainId) continue;
			enrollment[domainId] = carryOtherDomain(slice);
		}
		enrollment[homeDomainId] = homeSlice;
		return { schema: FEDERATION_SECRET_SCHEMA, identity: evieIdentity, enrollment };
	}
	return { identity: evieIdentity, enrollment: homeSlice };
}

/** Build the rooted home slice from the incumbent home state. Keeps the existing allowlist +
 * profileName only when re-rooting at the SAME owner; a different owner key is a fresh Domain
 * (prior admissions would not verify under it, and its profileName was the prior owner's label,
 * so both are dropped).
 *
 * OFF the default provision() path: that path pre-stages a PENDING home (the phone first-roots on
 * scan) and, on a re-provision of an already-rooted home, never rewrites the Secret at all - so the
 * live re-provision preserves profileName by NOT TOUCHING the slice, not through this helper. This
 * helper serves the owner-key-in-hand rooting case only (`bootstrapDomain`). */
function rootHomeSlice(
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
		...(sameOwner && prior?.profileName != null ? { profileName: prior.profileName } : {}),
		isAdminDomain: true,
	};
}

/** Root evie's Domain at the owner's public keys, preserving evie's identity. `evieFedJson` is the
 * live evie federation.json text; the owner keys are base64 raw-32-byte public keys.
 *
 * OFF the default provision() path: the fresh setup pre-stages a PENDING home (`pendingHomeDomain`)
 * and the operator's phone first-roots on scan, so the host never holds the owner key. This
 * owner-key-paste rooting is kept for the same-owner re-root-from-backup case (a caller that already
 * holds the public keys). It mints nothing and signs nothing.
 *
 * v2-aware: an already multi-tenant Secret is read and only its HOME slice is replaced, so other
 * Domains and home's own admissions survive; the WHOLE map is written back with the v2 marker. A
 * legacy v1 Secret keeps the original single-Domain write. */
export function bootstrapDomain(
	evieFedJson: string,
	homeDomainId: string,
	ownerSignPub: string,
	ownerBoxPub: string,
): BootstrapResult {
	assertKey("owner signing key", ownerSignPub);
	assertKey("owner box key", ownerBoxPub);
	const { evieFed, evieIdentity } = readEvieFederation(evieFedJson);
	const home = rootHomeSlice(homeSliceOf(evieFed, homeDomainId), ownerSignPub, ownerBoxPub);
	return { ownerSignPub, federationJson: composeFederationJson(evieFed, evieIdentity, home, homeDomainId) };
}

/** Build the PENDING home slice: an profileName label + a one-time invite nonce, NO owner root.
 * The fresh setup writes this so the operator's phone first-roots the home Domain on scan, exactly
 * like a friend. Mirrors evie's pending slice (`{ ownerSignPub: null, ownerBoxPub: null, admissions:
 * [], revocations: [], profileName, pendingTenant }`) so evie reads it back without complaint. The
 * nonce is minted by the caller (standard base64, never base64url - the wire `nonce` is a b64Field). */
function pendingHomeSlice(profileName: string, nonce: string, issuedAt: number, ttlMs: number): DomainEnrollment {
	return {
		ownerSignPub: null,
		ownerBoxPub: null,
		admissions: [],
		revocations: [],
		profileName,
		pendingTenant: { profileName, nonce, issuedAt, ttlMs, rooted: false },
		isAdminDomain: true,
	};
}

/** Pre-stage the home Domain as a PENDING tenant in evie's Secret, preserving evie's identity +
 * every friend Domain. `evieFedJson` is the live evie federation.json text. The caller mints the
 * one-time invite `nonce` (standard base64) and emits it in the blob's `pendingTenant` so the
 * operator's phone first-roots on scan. This is the fresh-setup path: there is no owner key to
 * root with (it is generated silently on the phone), so the home slice is rootless until the
 * first_root lands. v2-aware, same as `bootstrapDomain`. */
export function pendingHomeDomain(
	evieFedJson: string,
	homeDomainId: string,
	profileName: string,
	nonce: string,
	issuedAt: number,
	ttlMs: number,
): PendingResult {
	const { evieFed, evieIdentity } = readEvieFederation(evieFedJson);
	const home = pendingHomeSlice(profileName, nonce, issuedAt, ttlMs);
	return { federationJson: composeFederationJson(evieFed, evieIdentity, home, homeDomainId) };
}

/** Inspect the incumbent home Domain slice to drive the fresh-vs-reprovision state machine.
 * `rooted` is true once an owner key is set (re-provision: emit the blob only). `ownerSignPub` is
 * that rooted owner key (so a re-provision can sanity-check a gateway's pinned owner against it).
 * `profileName` is the home network's label if any (preserved across a re-provision). A malformed
 * Secret reads as a fresh, unrooted home (so setup pre-stages it) rather than throwing here. */
export function readHomeDomain(
	evieFedJson: string,
	homeDomainId: string,
): {
	rooted: boolean;
	ownerSignPub: string | null;
	profileName: string | null;
} {
	let evieFed: LegacyEvieFederation | MultiDomainEvieFederation;
	try {
		evieFed = JSON.parse(evieFedJson) as LegacyEvieFederation | MultiDomainEvieFederation;
	} catch {
		return { rooted: false, ownerSignPub: null, profileName: null };
	}
	const home = homeSliceOf(evieFed, homeDomainId);
	const ownerSignPub = home?.ownerSignPub ?? null;
	const profileName = home?.profileName ?? home?.pendingTenant?.profileName ?? null;
	return { rooted: ownerSignPub != null, ownerSignPub, profileName };
}
