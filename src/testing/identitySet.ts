// The fixed identity set, and how each runtime is seeded with its half of it.

import fs from "node:fs";
import path from "node:path";
import { FEDERATION_SECRET_SCHEMA } from "../federation-server/federationSecret.js";
import { FileSecretStore } from "../federation-server/fileSecretStore.js";
import { ALLOWLIST_FILE, Allowlist } from "../gateway/federation/allowlist.js";
import { CONTENT_KEYS_FILE, ContentKeyStore } from "../gateway/federation/contentKeyStore.js";
import type { SignedAdmission } from "../shared/admission.js";
import type { Identity } from "../shared/crypto.js";

////////////////////////////////
//  Interfaces & Types

export interface IdentitySet {
	issuedAt: number;
	router: { identity: Identity };
	domain: { id: string; owner: Identity; isAdminDomain: boolean };
	gateway: { id: string; identity: Identity; admission: SignedAdmission };
	console: { device: string; conversationId: string; identity: Identity; admission: SignedAdmission };
	tokens: { console: string; federation: string; host: string };
	content: { epoch: number; key: string };
}

export interface RouterTransportSeed {
	routerUrl: string;
	routerCertFp: string;
}

////////////////////////////////
//  Functions & Helpers

const SET_FILE = path.resolve(import.meta.dirname, "../../tests/fixtures/identity/set.json");

export function loadIdentitySet(): IdentitySet {
	return JSON.parse(fs.readFileSync(SET_FILE, "utf8")) as IdentitySet;
}

export function contentKeyOf(set: IdentitySet): Buffer {
	return Buffer.from(set.content.key, "base64");
}

/** Writes the Router's federation file with the fixed identity, then opens the store over it. */
export async function seedRouter(dataDir: string, set: IdentitySet): Promise<FileSecretStore> {
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(
		path.join(dataDir, "federation.json"),
		JSON.stringify({
			schema: FEDERATION_SECRET_SCHEMA,
			identity: set.router.identity,
			enrollment: {},
			seenAdminNonces: [],
		}),
		{ mode: 0o600 },
	);
	const store = new FileSecretStore(dataDir);
	await store.init();
	store.saveDomain(set.domain.id, {
		ownerSignPub: set.domain.owner.sign.pub,
		ownerBoxPub: set.domain.owner.box.pub,
		admissions: [set.gateway.admission, set.console.admission],
		revocations: [],
		isAdminDomain: set.domain.isAdminDomain,
	});
	await store.flushDomain(set.domain.id);
	return store;
}

/** Writes the federation files a gateway reads at boot; `contentKey: false` leaves the keyring empty. */
export function seedGateway(
	federationDir: string,
	set: IdentitySet,
	transport: RouterTransportSeed,
	options: { contentKey?: boolean } = {},
): void {
	fs.mkdirSync(federationDir, { recursive: true });
	fs.writeFileSync(path.join(federationDir, "federation-identity.json"), JSON.stringify(set.gateway.identity), {
		mode: 0o600,
	});
	Allowlist.writeFile(path.join(federationDir, ALLOWLIST_FILE), {
		ownerSignPub: set.domain.owner.sign.pub,
		domainId: set.domain.id,
		admissions: [set.gateway.admission, set.console.admission],
		revocations: [],
	});
	fs.writeFileSync(
		path.join(federationDir, "transport.json"),
		JSON.stringify({ ...transport, bearer: set.tokens.federation }),
		{ mode: 0o600 },
	);
	if (options.contentKey === false) return;
	ContentKeyStore.writeFile(
		path.join(federationDir, CONTENT_KEYS_FILE),
		new Map([[set.content.epoch, contentKeyOf(set)]]),
	);
}
