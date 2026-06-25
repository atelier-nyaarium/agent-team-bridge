import os from "node:os";
import { GATEWAY_QUALIFIER_SEP } from "./console-protocol.js";

////////////////////////////////
//  Functions & Helpers

/** Sanitize a raw Gateway id into a stable slug usable as a name qualifier: lower
 * case, non-alphanumerics collapse to single dashes, ends trimmed. The
 * qualifier separator can never survive, so a sanitized id never splits wrong in
 * `parseQualifiedTeam`. Empty input falls back to "gateway". */
export function sanitizeGatewayId(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.includes(GATEWAY_QUALIFIER_SEP))
		throw new Error("sanitized Gateway id must not contain the qualifier separator");
	return slug || "gateway";
}

/** The local Gateway's id: `GATEWAY_ID` env override, else the machine hostname,
 * sanitized. Resolved once at gateway boot and threaded through the config so
 * every wire surface qualifies names under the same id. */
export function resolveLocalGatewayId(): string {
	return sanitizeGatewayId(process.env.GATEWAY_ID || os.hostname() || "gateway");
}
