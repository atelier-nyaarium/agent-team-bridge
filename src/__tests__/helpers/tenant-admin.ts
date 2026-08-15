import type { FederationSecret } from "../../federation-server/federationSecret.js";
import { FileSecretStore } from "../../federation-server/fileSecretStore.js";
import type { SecretIO } from "../../federation-server/secretIO.js";
import { generateIdentity } from "../../shared/crypto.js";
import {
	type FirstRoot,
	type ProvisionTenant,
	type RemoveTenant,
	signFirstRoot,
	signProvisionTenant,
	signRemoveTenant,
} from "../../shared/federation-lifecycle.js";

export const adminOwner = generateIdentity();
export const now = 1_000_000;

export function fakeIO() {
	let stored: FederationSecret | null = null;
	let version = 0;
	const io: SecretIO = {
		read: async () => (stored ? { value: stored, resourceVersion: String(version) } : null),
		write: async (v) => {
			stored = v;
			version += 1;
		},
	};
	return { io, get: () => stored };
}

export async function freshStore(sharedIO?: SecretIO): Promise<FileSecretStore> {
	const io = sharedIO ?? fakeIO().io;
	const store = new FileSecretStore("/tmp", io);
	await store.init();
	return store;
}

export function provision(domainId: string, displayName = "Carol", at = now, nonce = "cHJvdmlzaW9u") {
	const p: ProvisionTenant = { domainId, displayName, issuedAt: at, nonce };
	return signProvisionTenant(p, adminOwner.sign.priv, adminOwner.sign.pub);
}
export function removal(domainId: string, at = now, nonce = "cmVtb3Zl") {
	const r: RemoveTenant = { domainId, issuedAt: at, nonce };
	return signRemoveTenant(r, adminOwner.sign.priv, adminOwner.sign.pub);
}
export function firstRoot(domainId: string, friend: ReturnType<typeof generateIdentity>, nonce: string, at = now) {
	const f: FirstRoot = { domainId, ownerSignPub: friend.sign.pub, ownerBoxPub: friend.box.pub, nonce, issuedAt: at };
	return signFirstRoot(f, friend.sign.priv);
}
