import { GATEWAY_QUALIFIER_SEP } from "./console-protocol.js";

////////////////////////////////
//  Functions & Helpers

/** The Domain a gateway, console, or wire frame resolves to when no explicit
 * Domain is named. Multi-tenant evie wraps the incumbent single-tenant Domain
 * under this id, so an absent domainId stays byte-identical to the pre-multi-tenant
 * world (the live gateway + shipped app keep working across the first roll). */
export const DEFAULT_DOMAIN_ID = "home";

/** Sanitize a raw Domain id into a stable slug: lower case, non-alphanumerics
 * collapse to single dashes, ends trimmed. The qualifier separator can never
 * survive, so a Domain id never splits a qualified name wrong. Empty input falls
 * back to the default Domain. */
export function sanitizeDomainId(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.includes(GATEWAY_QUALIFIER_SEP))
		throw new Error("sanitized Domain id must not contain the qualifier separator");
	return slug || DEFAULT_DOMAIN_ID;
}

/** The local Gateway's Domain id: `FEDERATION_DOMAIN_ID` env override, else the
 * default Domain, sanitized. An absent override keeps a single-tenant gateway on
 * the `home` Domain, so it stays byte-compatible with a pre-multi-tenant evie. */
export function resolveLocalDomainId(): string {
	return sanitizeDomainId(process.env.FEDERATION_DOMAIN_ID || DEFAULT_DOMAIN_ID);
}
