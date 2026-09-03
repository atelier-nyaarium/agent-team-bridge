import { createHash } from "node:crypto";
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
	const marker = path.join(dataDir, IN_PROGRESS);
	if (fs.existsSync(marker)) {
		try {
			const prior = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid?: number };
			if (typeof prior.pid === "number") {
				try {
					process.kill(prior.pid, 0);
					throw new Error(`import already in progress by pid ${prior.pid}`);
				} catch (error) {
					if (error instanceof Error && error.message.startsWith("import already")) throw error;
				}
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("import already")) throw error;
		}
	}
	writeFileAtomic(marker, JSON.stringify({ pid: process.pid, note }), {
		mode: 0o600,
		fsyncFile: true,
		fsyncDirectory: true,
	});
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
		if (match) {
			const name = match[2]!.trim();
			if (name in out) throw new Error(`duplicate SHA256SUMS entry: ${name}`);
			out[name] = match[1]!;
		}
	}
	return out;
}

export function declaredDigest(sums: Record<string, string>, name: string): string | null {
	return sums[name] ?? null;
}

export function verifySums(directory: string, contents: string): string[] {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
		if (!match) {
			errors.push("malformed line");
			continue;
		}
		const name = match[2]!.trim();
		if (seen.has(name)) {
			errors.push(`${name}: duplicate`);
			continue;
		}
		seen.add(name);
		const root = path.resolve(directory);
		const file = path.resolve(root, name);
		if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
			errors.push(`${name}: invalid path`);
			continue;
		}
		if (!fs.existsSync(file)) {
			errors.push(`${name}: missing`);
			continue;
		}
		const found = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		if (found !== match[1]) errors.push(`${name}: digest`);
	}
	return errors;
}
