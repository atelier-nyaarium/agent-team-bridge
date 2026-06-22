// Domain rooting for the owner setup flow.
//
// Phone-anchored trust: the OWNER root keypair is generated on the admin Console and never leaves
// it. This roots evie's Domain at the Console's owner PUBLIC keys (read by the operator from the
// app) - it mints nothing and signs nothing, so no private key is created or held host-side. The
// Console admits every Gateway and Console itself afterward, so this runs once to seat the root.
//
// Preserves evie's own identity verbatim (rooting must not change evie's SAS). Prior admissions /
// revocations are kept ONLY when re-rooting at the SAME owner key (a Console re-running setup from
// its backed-up owner key); a DIFFERENT owner key starts a fresh Domain (old admissions were signed
// by a key that no longer verifies).
//
// Multi-tenant aware: evie's federation Secret may already be the v2 multi-domain shape
// (`{ schema:2, identity, enrollment: { <domainId>: state } }`) hosting OTHER owners' Domains.
// --setup roots only the HOME Domain, so a v2 Secret is read, the home slice is replaced in place,
// and the WHOLE map is written back - never clobbering a friend Domain or dropping home's
// admissions. A legacy v1 Secret (`{ identity, enrollment: <state> }`) keeps the original
// single-Domain write path.

import type { SignedAdmission, SignedRevocation } from "../src/shared/admission.js";
import type { Identity } from "../src/shared/crypto.js";
import { DEFAULT_DOMAIN_ID } from "../src/shared/domain-id.js";

////////////////////////////////
//  Interfaces & Types

/** One Domain's owner-rooted allowlist slice (a v2 per-domain entry, and the v1
 * single-Domain `enrollment` payload - the two shapes share this object). */
interface DomainEnrollment {
	ownerSignPub: string;
	ownerBoxPub: string;
	admissions: SignedAdmission[];
	revocations: SignedRevocation[];
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

/** Build the home Domain's slice from the incumbent home state. Keeps the existing
 * allowlist only when re-rooting at the same owner; a different owner key is a fresh
 * Domain (prior admissions would not verify under it, so they are dropped). */
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
	};
}

/** Root evie's Domain at the Console owner's public keys, preserving evie's identity. `evieFedJson`
 * is the live evie federation.json text; the owner keys are base64 raw-32-byte public keys.
 *
 * v2-aware: an already multi-tenant Secret is read and only its HOME slice is replaced, so other
 * Domains and home's own admissions survive; the WHOLE map is written back with the v2 marker. A
 * legacy v1 Secret keeps the original single-Domain write. */
export function bootstrapDomain(evieFedJson: string, ownerSignPub: string, ownerBoxPub: string): BootstrapResult {
	assertKey("owner signing key", ownerSignPub);
	assertKey("owner box key", ownerBoxPub);

	// evie's CURRENT identity, preserved verbatim so rooting never re-mints evie's keypair (which
	// would change its fingerprint). A malformed Secret gets an actionable message, not a raw
	// SyntaxError, the same way assertKey rejects a bad owner key.
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

	if (isMultiDomain(evieFed)) {
		// Multi-tenant: read the whole map, replace ONLY the home slice, write the map back.
		// A blind v1 overwrite here would obliterate every non-home Domain and drop home's
		// admissions (data loss, P5).
		const incumbent = evieFed.enrollment ?? {};
		const home = rootHomeSlice(incumbent[DEFAULT_DOMAIN_ID], ownerSignPub, ownerBoxPub);
		// Normalize every other Domain's slice to the full shape so the written map is
		// well-formed, but otherwise carry it through untouched.
		const enrollment: Record<string, DomainEnrollment> = {};
		for (const [domainId, slice] of Object.entries(incumbent)) {
			if (domainId === DEFAULT_DOMAIN_ID) continue;
			enrollment[domainId] = {
				ownerSignPub: slice?.ownerSignPub ?? "",
				ownerBoxPub: slice?.ownerBoxPub ?? "",
				admissions: slice?.admissions ?? [],
				revocations: slice?.revocations ?? [],
			};
		}
		enrollment[DEFAULT_DOMAIN_ID] = home;
		return {
			ownerSignPub,
			federationJson: { schema: FEDERATION_SECRET_SCHEMA, identity: evieIdentity, enrollment },
		};
	}

	// Legacy (v1) / first-root: the original single-Domain write path, unchanged.
	const home = rootHomeSlice((evieFed as LegacyEvieFederation).enrollment, ownerSignPub, ownerBoxPub);
	return {
		ownerSignPub,
		federationJson: { identity: evieIdentity, enrollment: home },
	};
}
