import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Router identity files survive imports. */
export const PRESERVED = ["federation.json", "router-cert.pem", "router-key.pem"] as const;

export const IMPORTED = ["owner"] as const;

export function isPreserved(name: string): boolean {
	return (PRESERVED as readonly string[]).includes(name);
}

export function preservedDigests(dataDir: string): Record<string, string> {
	const digests: Record<string, string> = {};
	for (const name of PRESERVED) {
		const target = path.join(dataDir, name);
		if (!fs.existsSync(target)) throw new Error(`preserved file missing: ${name}`);
		digests[name] = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
	}
	return digests;
}

/** Compares preserved contents. */
export function violations(
	before: Readonly<Record<string, string>>,
	after: Readonly<Record<string, string>>,
): string[] {
	return PRESERVED.filter((name) => before[name] !== after[name]);
}
