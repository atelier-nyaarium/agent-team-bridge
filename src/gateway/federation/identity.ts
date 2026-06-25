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

/** Load this Gateway's federation identity from its volume, minting + persisting one
 * (tight perms, private keys never leaving the file) on first boot. Stable across
 * restarts so the Gateway keeps its admitted key.
 *
 * Fail closed on a present-but-broken file: only an ABSENT identity (ENOENT) mints. A file
 * that exists but does not parse or validate is an orphan signal (a partial write, a disk
 * fault, the wrong volume mounted), never a reason to mint a throwaway key that abandons the
 * admitted one - so a human investigates instead of the Gateway silently re-rooting itself. */
export function loadOrCreateIdentity(dataDir: string): Identity {
	const file = path.join(dataDir, IDENTITY_FILE);
	let raw: string | null = null;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		// ENOENT is the one mint case; any other read failure over a present file must not mint over it.
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw new Error(`[identity] cannot read ${file}: ${(err as Error)?.message ?? err}`);
		}
	}
	if (raw !== null) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(
				`[identity] ${file} is present but not valid JSON; refusing to overwrite the admitted key. Restore it from backup, or remove it to mint a fresh identity.`,
			);
		}
		if (!isIdentity(parsed)) {
			throw new Error(
				`[identity] ${file} is present but not a valid identity; refusing to overwrite the admitted key. Restore it from backup, or remove it to mint a fresh identity.`,
			);
		}
		// Log the LOADED signing fingerprint (parity with the mint path below), so an admin
		// can confirm the Gateway kept its admitted key and spot a silent identity change.
		console.log(`[identity] loaded federation identity (signing fp ${fingerprint(parsed.sign.pub)})`);
		return parsed;
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
