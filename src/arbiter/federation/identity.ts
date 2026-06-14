import fs from "node:fs";
import path from "node:path";
import { fingerprint, generateIdentity, type Identity } from "../../shared/crypto.js";

////////////////////////////////
//  Functions & Helpers

const IDENTITY_FILE = "federation-identity.json";

function isIdentity(v: unknown): v is Identity {
	const id = v as Identity | null;
	return Boolean(id?.sign?.pub && id?.sign?.priv && id?.box?.pub && id?.box?.priv);
}

/** Load this Host's federation identity from its volume, minting + persisting one
 * (tight perms, private keys never leaving the file) on first boot. Stable across
 * restarts so the Host keeps its admitted key. */
export function loadOrCreateIdentity(dataDir: string): Identity {
	const file = path.join(dataDir, IDENTITY_FILE);
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isIdentity(parsed)) return parsed;
		console.warn(`[identity] ${file} is malformed; minting a fresh identity`);
	} catch {
		// Absent or unreadable: mint below.
	}
	const id = generateIdentity();
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(id), { mode: 0o600 });
	try {
		fs.chmodSync(file, 0o600);
	} catch {}
	console.log(`[identity] minted federation identity (signing fp ${fingerprint(id.sign.pub)})`);
	return id;
}
