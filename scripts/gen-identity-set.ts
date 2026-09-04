// Re-minting invalidates every derived fixture.

import fs from "node:fs";
import path from "node:path";
import { signAdmission } from "../src/shared/admission.js";
import { deriveContentKey } from "../src/shared/content-envelope.js";
import { generateIdentity } from "../src/shared/crypto.js";

const OUT = path.resolve(import.meta.dirname, "../tests/fixtures/identity/set.json");
const ISSUED_AT = 1_757_000_000_000;

if (fs.existsSync(OUT) && !process.argv.includes("--force")) {
	console.error(`${OUT} exists; pass --force to mint a new set, which stales every fixture minted from it`);
	process.exit(1);
}

const domainId = "fixture-domain";
const gatewayId = "laptop";
const owner = generateIdentity();
const router = generateIdentity();
const gateway = generateIdentity();
const console_ = generateIdentity();

const set = {
	issuedAt: ISSUED_AT,
	router: { identity: router },
	domain: { id: domainId, owner, isAdminDomain: true },
	gateway: {
		id: gatewayId,
		identity: gateway,
		admission: signAdmission(
			{
				kind: "gateway",
				signPub: gateway.sign.pub,
				boxPub: gateway.box.pub,
				gatewayId,
				issuedAt: ISSUED_AT,
				nonce: "fixture-gateway-admission",
			},
			owner.sign.priv,
			owner.sign.pub,
		),
	},
	console: {
		device: "fixture-phone",
		conversationId: "fixture-console",
		identity: console_,
		admission: signAdmission(
			{
				kind: "console",
				signPub: console_.sign.pub,
				boxPub: console_.box.pub,
				issuedAt: ISSUED_AT,
				nonce: "fixture-console-admission",
			},
			owner.sign.priv,
			owner.sign.pub,
		),
	},
	tokens: {
		console: "fixture-console-token",
		federation: "fixture-federation-token",
		host: "fixture-host-token",
	},
	content: { epoch: 1, key: deriveContentKey(owner.sign.priv, domainId, 1).toString("base64") },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(set, null, "\t")}\n`);
console.log(`wrote ${OUT}`);
