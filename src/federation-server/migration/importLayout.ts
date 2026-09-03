import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../shared/atomic-write.js";

/** Router identity files survive imports. */
export const PRESERVED = ["federation.json", "router-cert.pem", "router-key.pem"] as const;

export const IMPORTED = ["owner", "migration-epoch"] as const;

export function writeImportedEpoch(dataDir: string, epoch: number): void {
	writeFileAtomic(path.join(dataDir, "migration-epoch"), String(epoch), {
		fsyncFile: true,
		fsyncDirectory: true,
	});
}

export function isPreserved(name: string): boolean {
	return (PRESERVED as readonly string[]).includes(name);
}

export function preservedDigests(dataDir: string): Record<string, string> {
	const digests: Record<string, string> = {};
	for (const name of PRESERVED) {
		const target = path.join(dataDir, name);
		if (!fs.existsSync(target)) throw new Error(`preserved file missing: ${name}`);
		if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`preserved file symlink: ${name}`);
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
