import { GATEWAY_QUALIFIER_SEP } from "./console-protocol.js";

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

/** The local Gateway's Domain id, from the required `FEDERATION_DOMAIN_ID` env (the random hex id
 * minted at provision and written into the gateway `.env`). Throws when unset: a gateway has no
 * default Domain - it must be provisioned with its own id. */
export function resolveLocalDomainId(): string {
	const id = process.env.FEDERATION_DOMAIN_ID;
	if (!id) throw new Error("FEDERATION_DOMAIN_ID is required (the gateway has no default Domain)");
	return sanitizeDomainId(id);
}
