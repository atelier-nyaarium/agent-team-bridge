import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FEDERATION_SECRET_SCHEMA } from "../federation-server/federationSecret.js";
import { FileSecretStore } from "../federation-server/fileSecretStore.js";
import { ALLOWLIST_FILE, Allowlist } from "../gateway/federation/allowlist.js";
import { CONTENT_KEYS_FILE, ContentKeyStore } from "../gateway/federation/contentKeyStore.js";
import { type SignedAdmission, signAdmission } from "../shared/admission.js";
import { deriveContentKey } from "../shared/content-envelope.js";
import { generateIdentity, type Identity } from "../shared/crypto.js";

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

const SET_FILE = path.resolve(import.meta.dirname, "../../tests/fixtures/identity/set.json");

export function loadIdentitySet(): IdentitySet {
	return JSON.parse(fs.readFileSync(SET_FILE, "utf8")) as IdentitySet;
}

export function contentKeyOf(set: IdentitySet): Buffer {
	return Buffer.from(set.content.key, "base64");
}

export interface MintIdentitySetOptions {
	domainId: string;
	gatewayId: string;
	isAdminDomain?: boolean;
	issuedAt?: number;
	/** Reuse one Router identity when seeding multiple Domains. */
	router?: Identity;
	tokens?: IdentitySet["tokens"];
	device?: string;
	conversationId?: string;
	nonces?: { gateway: string; console: string };
}

export function mintIdentitySet(options: MintIdentitySetOptions): IdentitySet {
	const issuedAt = options.issuedAt ?? Date.now();
	const owner = generateIdentity();
	const gateway = generateIdentity();
	const console_ = generateIdentity();
	const nonces = options.nonces ?? {
		gateway: randomBytes(12).toString("base64"),
		console: randomBytes(12).toString("base64"),
	};
	return {
		issuedAt,
		router: { identity: options.router ?? generateIdentity() },
		domain: { id: options.domainId, owner, isAdminDomain: options.isAdminDomain ?? false },
		gateway: {
			id: options.gatewayId,
			identity: gateway,
			admission: signAdmission(
				{
					kind: "gateway",
					signPub: gateway.sign.pub,
					boxPub: gateway.box.pub,
					gatewayId: options.gatewayId,
					issuedAt,
					nonce: nonces.gateway,
				},
				owner.sign.priv,
				owner.sign.pub,
			),
		},
		console: {
			device: options.device ?? `${options.domainId}-phone`,
			conversationId: options.conversationId ?? `${options.domainId}-console`,
			identity: console_,
			admission: signAdmission(
				{
					kind: "console",
					signPub: console_.sign.pub,
					boxPub: console_.box.pub,
					issuedAt,
					nonce: nonces.console,
				},
				owner.sign.priv,
				owner.sign.pub,
			),
		},
		tokens: options.tokens ?? {
			console: `${options.domainId}-console-token`,
			federation: `${options.domainId}-federation-token`,
			host: `${options.domainId}-host-token`,
		},
		content: { epoch: 1, key: deriveContentKey(owner.sign.priv, options.domainId, 1).toString("base64") },
	};
}

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
	await seedDomain(store, set);
	return store;
}

export async function seedDomain(store: FileSecretStore, set: IdentitySet): Promise<void> {
	store.saveDomain(set.domain.id, {
		ownerSignPub: set.domain.owner.sign.pub,
		ownerBoxPub: set.domain.owner.box.pub,
		admissions: [set.gateway.admission, set.console.admission],
		revocations: [],
		isAdminDomain: set.domain.isAdminDomain,
	});
	await store.flushDomain(set.domain.id);
}

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
