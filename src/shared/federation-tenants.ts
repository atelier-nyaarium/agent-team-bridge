import { z } from "zod";
import { b64Field, displayField, fingerprint, sign, slugField, verify } from "./crypto.js";

////////////////////////////////
//  Friend cross-Domain onboarding (pending tenant + first-root + display name)
//
//  The admin pre-stages a friend's Domain as a PENDING tenant (a domainId + a
//  displayName label, NO owner root) and mints a one-time invite QR; the friend's app
//  first-roots the Domain at its silently-generated owner key on first connect. The
//  signing artifacts below ride the app-token-gated bridge to evie:
//
//  - provision_tenant / remove_tenant: ADMIN-signed. evie creates / drops the pending tenant.
//  - first_root: SELF-signed by the friend's fresh owner key (no admission exists yet),
//    carrying the one-time QR nonce; evie roots the pending Domain at it, idempotent on the
//    same key, refusing a re-root at a different key.
//  - set_display_name: OWNER-signed; evie CAS-merges the rename and pushes it to the Domain's
//    own gateways, while linked Peers see it on their next discovery refresh.
//
//  Each preimage is the SAME versioned, newline-joined, fixed-order encoding as
//  admissionSigningBytes, and every field is base64, slug, decimal, or a newline-free
//  display string, so no field can carry a newline that makes the encoding ambiguous.
//  `displayName` carries no trust weight under the cooperative threat model (it cannot
//  forge an identity, only re-spell the label). Handlers MUST read each value from the
//  PARSED object, never by re-splitting the preimage. Do NOT sign raw JSON.

////////////////////////////////
//  Schemas

/** A pending (rootless) tenant the admin pre-stages: a domainId + a displayName
 * display label, the one-time invite nonce (issuedAt + ttlMs server-checked at evie),
 * and `rooted` flipped true once a friend's first_root spends the nonce. */
export const PendingTenantSchema = z
	.object({
		// The opaque Domain id (slug; never shown to the human - pure plumbing).
		domainId: slugField(),
		// The friendly display name (one per owner/Domain). Free text the admin
		// pre-sets and the friend edits from their profile once in.
		displayName: displayField(128),
		// The one-time invite nonce (base64), spent on the first successful first-root.
		nonce: b64Field(),
		// When the invite was minted (epoch ms); the TTL is measured from this.
		issuedAt: z.number().int().nonnegative(),
		// Invite lifetime (ms); evie sweeps an unredeemed pending tenant at issuedAt + ttlMs.
		ttlMs: z.number().int().nonnegative(),
		// True once a friend's first_root has rooted this Domain; the invite is then spent.
		rooted: z.boolean(),
	})
	.meta({ id: "PendingTenant" });

/** The admin's request to create a pending tenant (admin-signed). The signing bytes
 * bind the admin's own fingerprint, so evie can pin the request to the admin's key. */
export const ProvisionTenantSchema = z
	.object({
		domainId: slugField(),
		displayName: displayField(128),
		issuedAt: z.number().int().nonnegative(),
		nonce: b64Field(),
	})
	.meta({ id: "ProvisionTenant" });

export const SignedProvisionTenantSchema = z
	.object({
		provision: ProvisionTenantSchema,
		// The admin's root signing public key (base64). evie checks it against the
		// admin's known key, never trusting this field alone; the signing bytes carry
		// its fingerprint.
		adminSignPub: b64Field(),
		// The admin's Ed25519 signature over provisionTenantSigningBytes (base64).
		signature: b64Field(),
	})
	.meta({ id: "SignedProvisionTenant" });

/** The admin's request to drop a pending tenant (admin-signed). */
export const RemoveTenantSchema = z
	.object({
		domainId: slugField(),
		issuedAt: z.number().int().nonnegative(),
		nonce: b64Field(),
	})
	.meta({ id: "RemoveTenant" });

export const SignedRemoveTenantSchema = z
	.object({
		removal: RemoveTenantSchema,
		adminSignPub: b64Field(),
		signature: b64Field(),
	})
	.meta({ id: "SignedRemoveTenant" });

/** The friend console's first-root of a pending Domain (SELF-signed by the fresh owner
 * key). No admission exists yet, so the verifier checks the signature against the frame's
 * OWN ownerSignPub; the one-time QR `nonce` (server-checked unspent at evie) is the
 * authorization, the self-signature only proves possession of the submitted owner key. */
export const FirstRootSchema = z
	.object({
		domainId: slugField(),
		// The friend's silently-generated owner root keys (base64) the Domain roots at.
		ownerSignPub: b64Field(),
		ownerBoxPub: b64Field(),
		// The one-time invite nonce from the QR (base64); evie roots only if it is unspent.
		nonce: b64Field(),
		issuedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "FirstRoot" });

export const SignedFirstRootSchema = z
	.object({
		firstRoot: FirstRootSchema,
		// The owner's self-signature over firstRootSigningBytes (base64), verified against
		// firstRoot.ownerSignPub (the key being rooted). No separate ownerSignPub field: the
		// signer IS the subject, so the key lives inside `firstRoot`.
		signature: b64Field(),
	})
	.meta({ id: "SignedFirstRoot" });

/** The owner's request to rename their Domain's display name (owner-signed). evie CAS-merges
 * it and pushes a domain_update to the Domain's OWN gateways, so the rename is immediate there;
 * linked Peers pick it up lazily on their next discovery refresh. */
export const SetDisplayNameSchema = z
	.object({
		domainId: slugField(),
		displayName: displayField(128),
		issuedAt: z.number().int().nonnegative(),
		nonce: b64Field(),
	})
	.meta({ id: "SetDisplayName" });

export const SignedSetDisplayNameSchema = z
	.object({
		rename: SetDisplayNameSchema,
		// The rooted owner's root signing public key (base64). evie checks it against the
		// Domain's rooted owner key, never trusting this field alone; the signing bytes carry
		// its fingerprint.
		ownerSignPub: b64Field(),
		// The owner's Ed25519 signature over setDisplayNameSigningBytes (base64).
		signature: b64Field(),
	})
	.meta({ id: "SignedSetDisplayName" });

/** A user deleting their OWN Domain (the app-only "Revoke and Delete Domain"). The rooted owner
 * signs a request to purge their whole Domain slice from evie - admissions, revocations, and links.
 * evie verifies the signer IS the Domain's rooted owner before dropping the slice. */
export const DeleteDomainSchema = z
	.object({
		domainId: slugField(),
		issuedAt: z.number().int().nonnegative(),
		nonce: b64Field(),
	})
	.meta({ id: "DeleteDomain" });

export const SignedDeleteDomainSchema = z
	.object({
		deletion: DeleteDomainSchema,
		// The rooted owner's root signing public key (base64). evie checks it against the
		// Domain's rooted owner key, never trusting this field alone.
		ownerSignPub: b64Field(),
		// The owner's Ed25519 signature over deleteDomainSigningBytes (base64).
		signature: b64Field(),
	})
	.meta({ id: "SignedDeleteDomain" });

export type PendingTenant = z.infer<typeof PendingTenantSchema>;
export type ProvisionTenant = z.infer<typeof ProvisionTenantSchema>;
export type SignedProvisionTenant = z.infer<typeof SignedProvisionTenantSchema>;
export type RemoveTenant = z.infer<typeof RemoveTenantSchema>;
export type SignedRemoveTenant = z.infer<typeof SignedRemoveTenantSchema>;
export type FirstRoot = z.infer<typeof FirstRootSchema>;
export type SignedFirstRoot = z.infer<typeof SignedFirstRootSchema>;
export type SetDisplayName = z.infer<typeof SetDisplayNameSchema>;
export type SignedSetDisplayName = z.infer<typeof SignedSetDisplayNameSchema>;
export type DeleteDomain = z.infer<typeof DeleteDomainSchema>;
export type SignedDeleteDomain = z.infer<typeof SignedDeleteDomainSchema>;

////////////////////////////////
//  Tenant lifecycle signing bytes (provision / remove / first-root / set-name / delete)
//
//  Each mirrors `admissionSigningBytes` in shape: a versioned, newline-joined,
//  fixed-order encoding. The signer's identity is bound by `fingerprint(signerSignPub)`
//  (grouped uppercase hex, newline-free); the full signing key rides the SIGNED wrapper
//  so the verifier can recompute the fingerprint AND check the signature. Distinct
//  version prefixes keep these artifacts non-interchangeable (a captured signature for
//  one can never replay as another). Do NOT sign raw JSON.

/** PROVISION_TENANT_V1 signing bytes (admin-signed; NO ownerSignPub - the tenant is
 * pending / rootless). `adminFingerprint` is the fingerprint of the admin key in
 * the signed wrapper. */
export function provisionTenantSigningBytes(p: ProvisionTenant, adminSignPubB64: string): Buffer {
	return Buffer.from(
		[
			"PROVISION_TENANT_V1",
			fingerprint(adminSignPubB64),
			p.domainId,
			p.displayName,
			String(p.issuedAt),
			p.nonce,
		].join("\n"),
		"utf8",
	);
}

/** Admin-sign a pending-tenant provision. */
export function signProvisionTenant(
	provision: ProvisionTenant,
	adminSignPrivB64: string,
	adminSignPubB64: string,
): SignedProvisionTenant {
	return {
		provision,
		adminSignPub: adminSignPubB64,
		signature: sign(provisionTenantSigningBytes(provision, adminSignPubB64), adminSignPrivB64),
	};
}

/** True if the provision verifies under the EXPECTED admin key. The claimed
 * adminSignPub must equal the expected key AND the signature must check. */
export function verifyProvisionTenant(s: SignedProvisionTenant, expectedAdminSignPubB64: string): boolean {
	if (s.adminSignPub !== expectedAdminSignPubB64) return false;
	return verify(
		provisionTenantSigningBytes(s.provision, expectedAdminSignPubB64),
		s.signature,
		expectedAdminSignPubB64,
	);
}

/** REMOVE_TENANT_V1 signing bytes (admin-signed). */
export function removeTenantSigningBytes(r: RemoveTenant, adminSignPubB64: string): Buffer {
	return Buffer.from(
		["REMOVE_TENANT_V1", fingerprint(adminSignPubB64), r.domainId, String(r.issuedAt), r.nonce].join("\n"),
		"utf8",
	);
}

/** Admin-sign a pending-tenant removal. */
export function signRemoveTenant(
	removal: RemoveTenant,
	adminSignPrivB64: string,
	adminSignPubB64: string,
): SignedRemoveTenant {
	return {
		removal,
		adminSignPub: adminSignPubB64,
		signature: sign(removeTenantSigningBytes(removal, adminSignPubB64), adminSignPrivB64),
	};
}

/** True if the removal verifies under the EXPECTED admin key. */
export function verifyRemoveTenant(s: SignedRemoveTenant, expectedAdminSignPubB64: string): boolean {
	if (s.adminSignPub !== expectedAdminSignPubB64) return false;
	return verify(removeTenantSigningBytes(s.removal, expectedAdminSignPubB64), s.signature, expectedAdminSignPubB64);
}

/** FIRST_ROOT_V1 signing bytes (SELF-signed by the fresh owner key; `ownerSignPub` is the
 * key being rooted, carried INSIDE the artifact, and `nonce` is the one-time QR token). */
export function firstRootSigningBytes(f: FirstRoot): Buffer {
	return Buffer.from(
		["FIRST_ROOT_V1", f.domainId, f.ownerSignPub, f.ownerBoxPub, f.nonce, String(f.issuedAt)].join("\n"),
		"utf8",
	);
}

/** Self-sign a first-root with the fresh owner signing key (the subject IS the signer). */
export function signFirstRoot(firstRoot: FirstRoot, ownerSignPrivB64: string): SignedFirstRoot {
	return { firstRoot, signature: sign(firstRootSigningBytes(firstRoot), ownerSignPrivB64) };
}

/** True if the first-root self-signature checks against the owner key it roots at
 * (firstRoot.ownerSignPub). Proves possession of the submitted owner key; the one-time
 * nonce (checked unspent at evie) is the authorization. */
export function verifyFirstRoot(s: SignedFirstRoot): boolean {
	return verify(firstRootSigningBytes(s.firstRoot), s.signature, s.firstRoot.ownerSignPub);
}

/** SET_DISPLAY_NAME_V1 signing bytes (owner-signed). `ownerFingerprint` is the
 * fingerprint of the rooted owner key in the signed wrapper. */
export function setDisplayNameSigningBytes(r: SetDisplayName, ownerSignPubB64: string): Buffer {
	return Buffer.from(
		[
			"SET_DISPLAY_NAME_V1",
			fingerprint(ownerSignPubB64),
			r.domainId,
			r.displayName,
			String(r.issuedAt),
			r.nonce,
		].join("\n"),
		"utf8",
	);
}

/** Owner-sign a display-name rename (the owner device holds the signing key). */
export function signSetDisplayName(
	rename: SetDisplayName,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedSetDisplayName {
	return {
		rename,
		ownerSignPub: ownerSignPubB64,
		signature: sign(setDisplayNameSigningBytes(rename, ownerSignPubB64), ownerSignPrivB64),
	};
}

/** True if the rename verifies under the EXPECTED owner key (the Domain's rooted owner). */
export function verifySetDisplayName(s: SignedSetDisplayName, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(setDisplayNameSigningBytes(s.rename, expectedOwnerSignPubB64), s.signature, expectedOwnerSignPubB64);
}

/** DELETE_DOMAIN_V1 signing bytes (owner-signed). The owner proves possession of the rooted key to
 * purge the whole Domain; the fingerprint binds the request to that owner. */
export function deleteDomainSigningBytes(d: DeleteDomain, ownerSignPubB64: string): Buffer {
	return Buffer.from(
		["DELETE_DOMAIN_V1", fingerprint(ownerSignPubB64), d.domainId, String(d.issuedAt), d.nonce].join("\n"),
		"utf8",
	);
}

/** Owner-sign a Domain deletion (the owner device holds the signing key). */
export function signDeleteDomain(
	deletion: DeleteDomain,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedDeleteDomain {
	return {
		deletion,
		ownerSignPub: ownerSignPubB64,
		signature: sign(deleteDomainSigningBytes(deletion, ownerSignPubB64), ownerSignPrivB64),
	};
}

/** True if the deletion verifies under the EXPECTED owner key (the Domain's rooted owner). */
export function verifyDeleteDomain(s: SignedDeleteDomain, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(deleteDomainSigningBytes(s.deletion, expectedOwnerSignPubB64), s.signature, expectedOwnerSignPubB64);
}
