// What an offline import may replace, and what it must carry through untouched.
//
// The preserved set is the reason this mode exists at all. A Router started without its identity
// mints a fresh one, and every gateway and phone in the fleet has pinned the old one, so an import
// that took the whole data directory with it would break the fleet it was run to migrate.

/** Router identity and enrollment state. An import never writes these. */
export const PRESERVED = ["federation.json", "router-cert.pem", "router-key.pem"] as const;

/** Owner state, which is exactly what an import carries. */
export const IMPORTED = ["owner"] as const;

export function isPreserved(name: string): boolean {
	return (PRESERVED as readonly string[]).includes(name);
}

/**
 * Names an import touched that it had no business touching. Compared by content rather than by
 * intent, so a writer that reaches a preserved path by some route nobody listed is still caught.
 */
export function violations(
	before: Readonly<Record<string, string>>,
	after: Readonly<Record<string, string>>,
): string[] {
	return PRESERVED.filter((name) => before[name] !== after[name]);
}
