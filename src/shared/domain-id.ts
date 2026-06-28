import fs from "node:fs";
import path from "node:path";
import { isSlug, MAX_SLUG_LEN } from "./session-id.js";

////////////////////////////////
//  Constants

/** Enrollment writes the delivered Domain id here, alongside transport.json. */
export const DOMAIN_ID_FILE = "domain-id";

////////////////////////////////
//  Functions & Helpers

/** Sanitize a raw Domain id into a stable address segment: lower case, non-alphanumerics collapse to
 * single dashes, ends trimmed, capped at the slug length. The output is a dotless slug, so a Domain
 * id can never split an address wrong. Empty / all-separator input THROWS: every Domain id names a
 * real Domain, so an unnameable id is a caller bug, not a value to default. */
export function sanitizeDomainId(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LEN)
		.replace(/-+$/g, "");
	if (!isSlug(slug)) throw new Error("domain id is empty after sanitizing");
	return slug;
}

/** The local Gateway's Domain id, or null when it has not been enrolled yet. Resolution order: the
 * enrollment-delivered `domain-id` file, then the `FEDERATION_DOMAIN_ID` env (the admin box's own
 * record). Null means the gateway boots standalone and opens its enrollment listener; a Domain is
 * required only to connect to evie. */
export function resolveLocalDomainId(federationDir: string): string | null {
	const id = readDomainIdFile(federationDir) ?? process.env.FEDERATION_DOMAIN_ID;
	return id ? sanitizeDomainId(id) : null;
}

function readDomainIdFile(federationDir: string): string | null {
	try {
		return fs.readFileSync(path.join(federationDir, DOMAIN_ID_FILE), "utf8").trim() || null;
	} catch {
		return null;
	}
}
