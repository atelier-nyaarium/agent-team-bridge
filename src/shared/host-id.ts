import os from "node:os";
import { SWITCH_QUALIFIER_SEP } from "./console-protocol.js";

////////////////////////////////
//  Functions & Helpers

/** Sanitize a raw Switch id into a stable slug usable as a name qualifier: lower
 * case, non-alphanumerics collapse to single dashes, ends trimmed. The
 * qualifier separator can never survive, so a sanitized id never splits wrong in
 * `parseQualifiedTeam`. Empty input falls back to "switch". */
export function sanitizeSwitchId(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.includes(SWITCH_QUALIFIER_SEP))
		throw new Error("sanitized Switch id must not contain the qualifier separator");
	return slug || "switch";
}

/** The local Switch's id: `SWITCH_ID` env override, else the machine hostname,
 * sanitized. Resolved once at arbiter boot and threaded through the config so
 * every wire surface qualifies names under the same id. */
export function resolveLocalSwitchId(): string {
	return sanitizeSwitchId(process.env.SWITCH_ID || os.hostname() || "switch");
}
