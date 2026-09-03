import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../shared/atomic-write.js";

/** Marker present means refuse serving. */
export const IN_PROGRESS = "import-in-progress";

export type ServeVerdict = { kind: "serve" } | { kind: "refuse"; reason: "import_unverified" };

export function decideServe(dataDir: string): ServeVerdict {
	return fs.existsSync(path.join(dataDir, IN_PROGRESS))
		? { kind: "refuse", reason: "import_unverified" }
		: { kind: "serve" };
}

export function beginImport(dataDir: string, note: string): void {
	writeFileAtomic(path.join(dataDir, IN_PROGRESS), note, { mode: 0o600, fsyncFile: true, fsyncDirectory: true });
}

/** Clear only after verification. */
export function finishImport(dataDir: string): void {
	// Directory fsync makes removal durable.
	const marker = path.join(dataDir, IN_PROGRESS);
	fs.rmSync(marker, { force: true });
	if (process.platform !== "win32") {
		const fd = fs.openSync(dataDir, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}
}

export function parseSums(contents: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of contents.split("\n")) {
		const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
		if (match) out[match[2]!.trim()] = match[1]!;
	}
	return out;
}

export function declaredDigest(sums: Record<string, string>, name: string): string | null {
	return sums[name] ?? null;
}
