/** Router identity files survive imports. */
export const PRESERVED = ["federation.json", "router-cert.pem", "router-key.pem"] as const;

export const IMPORTED = ["owner"] as const;

export function isPreserved(name: string): boolean {
	return (PRESERVED as readonly string[]).includes(name);
}

/** Compares preserved contents. */
export function violations(
	before: Readonly<Record<string, string>>,
	after: Readonly<Record<string, string>>,
): string[] {
	return PRESERVED.filter((name) => before[name] !== after[name]);
}
