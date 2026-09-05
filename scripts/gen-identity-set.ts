// Re-minting invalidates every derived fixture.

import fs from "node:fs";
import path from "node:path";
import { mintIdentitySet } from "../src/testing/identitySet.js";

const OUT = path.resolve(import.meta.dirname, "../tests/fixtures/identity/set.json");
const ISSUED_AT = 1_757_000_000_000;

if (fs.existsSync(OUT) && !process.argv.includes("--force")) {
	console.error(`${OUT} exists; pass --force to mint a new set, which stales every fixture minted from it`);
	process.exit(1);
}

const set = mintIdentitySet({
	domainId: "fixture-domain",
	gatewayId: "laptop",
	isAdminDomain: true,
	issuedAt: ISSUED_AT,
	device: "fixture-phone",
	conversationId: "fixture-console",
	nonces: { gateway: "fixture-gateway-admission", console: "fixture-console-admission" },
	tokens: {
		console: "fixture-console-token",
		federation: "fixture-federation-token",
		host: "fixture-host-token",
	},
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(set, null, "\t")}\n`);
console.log(`wrote ${OUT}`);
