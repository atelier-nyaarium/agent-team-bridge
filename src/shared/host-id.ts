import os from "node:os";
import { HOST_QUALIFIER_SEP } from "./phone-protocol.js";

////////////////////////////////
//  Functions & Helpers

/** Sanitize a raw host id into a stable slug usable as a name qualifier: lower
 * case, non-alphanumerics collapse to single dashes, ends trimmed. The
 * qualifier separator can never survive, so a sanitized id never splits wrong in
 * `parseQualifiedTeam`. Empty input falls back to "host". */
export function sanitizeHostId(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.includes(HOST_QUALIFIER_SEP))
		throw new Error("sanitized host id must not contain the qualifier separator");
	return slug || "host";
}

/** The local Host's id: `HOST_ID` env override, else the machine hostname,
 * sanitized. Resolved once at arbiter boot and threaded through the config so
 * every wire surface qualifies names under the same id. */
export function resolveLocalHostId(): string {
	return sanitizeHostId(process.env.HOST_ID || os.hostname() || "host");
}
