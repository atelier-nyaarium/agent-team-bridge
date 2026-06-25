import fs from "node:fs";
import path from "node:path";
import { GATEWAY_QUALIFIER_SEP } from "./console-protocol.js";

////////////////////////////////
//  Constants

/** Enrollment writes the delivered Domain id here, alongside transport.json. */
export const DOMAIN_ID_FILE = "domain-id";

////////////////////////////////
//  Functions & Helpers

/** Sanitize a raw Domain id into a stable slug: lower case, non-alphanumerics collapse to single
 * dashes, ends trimmed. The qualifier separator can never survive, so a Domain id never splits a
 * qualified name wrong. Empty / all-separator input THROWS: every Domain id names a real Domain, so
 * an unnameable id is a caller bug, not a value to default. */
export function sanitizeDomainId(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.includes(GATEWAY_QUALIFIER_SEP))
		throw new Error("sanitized Domain id must not contain the qualifier separator");
	if (!slug) throw new Error("domain id is empty after sanitizing");
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
