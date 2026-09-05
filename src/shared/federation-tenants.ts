import { z } from "zod";
import { b64Field, displayField, fingerprint, sign, slugField, verify } from "./crypto.js";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

// Tenant artifacts use fixed signing order.
export const PendingTenantSchema = z
	.object({
		domainId: slugField(),
		displayName: displayField(128),
		nonce: b64Field(),
		issuedAt: z.number().int().nonnegative(),
		ttlMs: z.number().int().nonnegative(),
		rooted: z.boolean(),
	})
	.meta({ id: "PendingTenant" });

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
		// Claimed admin key precedes verification.
		adminSignPub: b64Field(),
		signature: b64Field(),
	})
	.meta({ id: "SignedProvisionTenant" });

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

export const FirstRootSchema = z
	.object({
		domainId: slugField(),
		ownerSignPub: b64Field(),
		ownerBoxPub: b64Field(),
		nonce: b64Field(),
		issuedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "FirstRoot" });

export const SignedFirstRootSchema = z
	.object({
		firstRoot: FirstRootSchema,
		// Self-signature proves rooted-key possession.
		signature: b64Field(),
	})
	.meta({ id: "SignedFirstRoot" });

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
		ownerSignPub: b64Field(),
		signature: b64Field(),
	})
	.meta({ id: "SignedSetDisplayName" });

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
		ownerSignPub: b64Field(),
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

export function provisionTenantSigningBytes(p: ProvisionTenant, adminSignPubB64: string): Buffer {
	// Sign parsed fields, not raw JSON.
	return Buffer.from(
		[
			SIGNING_TAGS.provisionTenant,
			fingerprint(adminSignPubB64),
			p.domainId,
			p.displayName,
			String(p.issuedAt),
			p.nonce,
		].join("\n"),
		"utf8",
	);
}

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

export function verifyProvisionTenant(s: SignedProvisionTenant, expectedAdminSignPubB64: string): boolean {
	if (s.adminSignPub !== expectedAdminSignPubB64) return false;
	return verify(
		provisionTenantSigningBytes(s.provision, expectedAdminSignPubB64),
		s.signature,
		expectedAdminSignPubB64,
	);
}

export function removeTenantSigningBytes(r: RemoveTenant, adminSignPubB64: string): Buffer {
	return Buffer.from(
		[SIGNING_TAGS.removeTenant, fingerprint(adminSignPubB64), r.domainId, String(r.issuedAt), r.nonce].join("\n"),
		"utf8",
	);
}

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

export function verifyRemoveTenant(s: SignedRemoveTenant, expectedAdminSignPubB64: string): boolean {
	if (s.adminSignPub !== expectedAdminSignPubB64) return false;
	return verify(removeTenantSigningBytes(s.removal, expectedAdminSignPubB64), s.signature, expectedAdminSignPubB64);
}

export function firstRootSigningBytes(f: FirstRoot): Buffer {
	// First-root signer is the carried owner key.
	return Buffer.from(
		[SIGNING_TAGS.firstRoot, f.domainId, f.ownerSignPub, f.ownerBoxPub, f.nonce, String(f.issuedAt)].join("\n"),
		"utf8",
	);
}

export function signFirstRoot(firstRoot: FirstRoot, ownerSignPrivB64: string): SignedFirstRoot {
	return { firstRoot, signature: sign(firstRootSigningBytes(firstRoot), ownerSignPrivB64) };
}

export function verifyFirstRoot(s: SignedFirstRoot): boolean {
	// Signature proves identity; Router authorizes the nonce.
	return verify(firstRootSigningBytes(s.firstRoot), s.signature, s.firstRoot.ownerSignPub);
}

export function setDisplayNameSigningBytes(r: SetDisplayName, ownerSignPubB64: string): Buffer {
	return Buffer.from(
		[
			SIGNING_TAGS.setDisplayName,
			fingerprint(ownerSignPubB64),
			r.domainId,
			r.displayName,
			String(r.issuedAt),
			r.nonce,
		].join("\n"),
		"utf8",
	);
}

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

export function verifySetDisplayName(s: SignedSetDisplayName, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(setDisplayNameSigningBytes(s.rename, expectedOwnerSignPubB64), s.signature, expectedOwnerSignPubB64);
}

export function deleteDomainSigningBytes(d: DeleteDomain, ownerSignPubB64: string): Buffer {
	return Buffer.from(
		[SIGNING_TAGS.deleteDomain, fingerprint(ownerSignPubB64), d.domainId, String(d.issuedAt), d.nonce].join("\n"),
		"utf8",
	);
}

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

export function verifyDeleteDomain(s: SignedDeleteDomain, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(deleteDomainSigningBytes(s.deletion, expectedOwnerSignPubB64), s.signature, expectedOwnerSignPubB64);
}
