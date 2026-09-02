// Whether a Router that has taken an import may answer for it.
//
// An import that cannot prove what it wrote must not start serving. The marker is the proof, and it
// is written only after verification passes, so its absence after an import began is itself a
// refusal rather than a missing convenience.

import fs from "node:fs";
import path from "node:path";

/** Written beside the owner directories the moment an import starts, and cleared when it verifies. */
export const IN_PROGRESS = "import-in-progress";

export type ServeVerdict =
	| { kind: "serve" }
	/** An import began and never verified. Serving now would answer from a half-written tree. */
	| { kind: "refuse"; reason: "import_unverified" };

export function decideServe(dataDir: string): ServeVerdict {
	return fs.existsSync(path.join(dataDir, IN_PROGRESS))
		? { kind: "refuse", reason: "import_unverified" }
		: { kind: "serve" };
}

/** Claims the marker before the first write. */
export function beginImport(dataDir: string, note: string): void {
	fs.writeFileSync(path.join(dataDir, IN_PROGRESS), note, { mode: 0o600 });
}

/** Drops it once counts and hashes have verified, which is the only path to serving again. */
export function finishImport(dataDir: string): void {
	fs.rmSync(path.join(dataDir, IN_PROGRESS), { force: true });
}

/** Parses a `<digest>  <name>` sums file into a lookup. */
export function parseSums(contents: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of contents.split("\n")) {
		const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
		if (match) out[match[2]!.trim()] = match[1]!;
	}
	return out;
}

/** The declared digest for a file, or null when the sums do not name it at all. An unnamed file is
 * refused rather than trusted: a cut that did not record it is not a cut anyone can verify. */
export function declaredDigest(sums: Record<string, string>, name: string): string | null {
	return sums[name] ?? null;
}
