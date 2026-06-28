import os from "node:os";
import { assertSlug, MAX_SLUG_LEN } from "./session-id.js";

////////////////////////////////
//  Functions & Helpers

/** Sanitize a raw Gateway id into a stable address segment: lowercase, non-alphanumerics collapse
 * to single dashes, ends trimmed, capped at the slug length. The output is a dotless slug (an
 * address segment), so it can never carry a separator into a parsed address. Empty input falls back
 * to "gateway". */
export function sanitizeGatewayId(raw: string): string {
	const slug =
		raw
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, MAX_SLUG_LEN)
			.replace(/-+$/g, "") || "gateway";
	assertSlug(slug);
	return slug;
}

/** The local Gateway's id: `GATEWAY_ID` env override, else the machine hostname,
 * sanitized. Resolved once at gateway boot and threaded through the config so
 * every wire surface qualifies names under the same id. */
export function resolveLocalGatewayId(): string {
	return sanitizeGatewayId(process.env.GATEWAY_ID || os.hostname() || "gateway");
}
