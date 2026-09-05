import fs from "node:fs";
import path from "node:path";
import { fingerprint, generateIdentity, type Identity } from "../../shared/crypto.js";

const IDENTITY_FILE = "federation-identity.json";

function isIdentity(v: unknown): v is Identity {
	const id = v as Identity | null;
	return Boolean(id?.sign?.pub && id?.sign?.priv && id?.box?.pub && id?.box?.priv);
}

/** Loads the persistent identity and fails closed on invalid existing data. */
export function loadOrCreateIdentity(dataDir: string, newId: () => string): Identity {
	const file = path.join(dataDir, IDENTITY_FILE);
	let raw: string | null = null;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		// Only ENOENT permits minting.
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
		console.log(`[identity] loaded federation identity (signing fp ${fingerprint(parsed.sign.pub)})`);
		return parsed;
	}
	const id = generateIdentity();
	fs.mkdirSync(dataDir, { recursive: true });
	const temp = `${file}.${newId()}`;
	let linked = false;
	try {
		const descriptor = fs.openSync(temp, "wx", 0o600);
		try {
			fs.writeFileSync(descriptor, JSON.stringify(id));
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		try {
			fs.linkSync(temp, file);
			linked = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		try {
			fs.unlinkSync(temp);
		} catch {}
	}
	if (!linked) return loadOrCreateIdentity(dataDir, newId);
	if (process.platform !== "win32") {
		const descriptor = fs.openSync(dataDir, "r");
		try {
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
	}
	console.log(`[identity] minted federation identity (signing fp ${fingerprint(id.sign.pub)})`);
	return id;
}
