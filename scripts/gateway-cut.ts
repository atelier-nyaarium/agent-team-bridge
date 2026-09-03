// Archive DATA_DIR while fenced.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../src/shared/atomic-write.js";
import {
	MIGRATION_SETTLE_MS,
	readMigrationEpochFile,
	readMigrationFenceRaisedAt,
	withMigrationInProgress,
} from "../src/shared/migration-fence.js";

const dataDir = process.env.DATA_DIR || "/app/data";

function argument(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`usage: bun run scripts/gateway-cut.ts --epoch <N> [--out <dir>]`);
	return value;
}

function epochArgument(): number {
	const value = argument("--epoch");
	if (!/^[1-9][0-9]*$/.test(value))
		throw new Error("usage: bun run scripts/gateway-cut.ts --epoch <N> [--out <dir>]");
	const epoch = Number(value);
	if (!Number.isSafeInteger(epoch))
		throw new Error("usage: bun run scripts/gateway-cut.ts --epoch <N> [--out <dir>]");
	return epoch;
}

function mergeSums(outDir: string, name: string, line: string): void {
	const sumsFile = path.join(outDir, "SHA256SUMS");
	const merged = new Map<string, string>();
	if (fs.existsSync(sumsFile)) {
		for (const existing of fs
			.readFileSync(sumsFile, "utf8")
			.split("\n")
			.filter((item) => item.trim())) {
			const separator = existing.indexOf("  ");
			if (separator < 0) throw new Error(`invalid SHA256SUMS line: ${existing}`);
			const filename = existing.slice(separator + 2);
			if (merged.has(filename)) throw new Error(`duplicate SHA256SUMS entry: ${filename}`);
			if (fs.existsSync(path.join(outDir, filename)) && filename !== name) merged.set(filename, existing);
		}
	}
	merged.set(name, line);
	writeFileAtomic(sumsFile, `${[...merged.values()].join("\n")}\n`, { mode: 0o600 });
}

export function cutExcludes(name: string, tempName: string): string[] {
	return [
		"--exclude",
		name,
		"--exclude",
		tempName,
		"--exclude",
		".tmp.*",
		"--exclude",
		".corrupt-*",
		"--exclude",
		"owner.lock",
		"--exclude",
		"import-in-progress",
		"--exclude",
		"export-in-progress",
	];
}

function main(): void {
	const epoch = epochArgument();
	const outDir = path.resolve(process.argv.includes("--out") ? argument("--out") : dataDir);
	console.log(`output ${outDir}`);
	withMigrationInProgress(dataDir, () => {
		// Refuse torn archives.
		const currentEpoch = readMigrationEpochFile(dataDir);
		if (currentEpoch === null) throw new Error("migration fence is not up; refusing to cut live state");
		if (currentEpoch === 0) throw new Error("migration fence has malformed epoch");
		if (currentEpoch !== epoch)
			throw new Error(`migration epoch mismatch: fence=${currentEpoch} argument=${epoch}`);
		const raisedAt = readMigrationFenceRaisedAt(dataDir);
		if (raisedAt === null || Date.now() - raisedAt < MIGRATION_SETTLE_MS)
			throw new Error(
				`migration fence has not settled; remaining seconds: ${Math.ceil((MIGRATION_SETTLE_MS - (raisedAt === null ? 0 : Date.now() - raisedAt)) / 1000)}`,
			);

		fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(outDir, 0o700);
		const name = `cut-${epoch}.tar`;
		const archive = path.join(outDir, name);
		const tempArchive = `${archive}.tmp.${process.pid}`;
		// Avoid archiving the output itself.
		if (path.resolve(path.dirname(archive)) === path.resolve(dataDir))
			console.warn(`[cut] writing into DATA_DIR; pass --out to keep the archive outside it`);
		execFileSync(
			"tar",
			[
				"--create",
				"--file",
				tempArchive,
				"--directory",
				dataDir,
				...cutExcludes(name, path.basename(tempArchive)),
				".",
			],
			{
				stdio: "inherit",
			},
		);

		let digest: string;
		try {
			digest = createHash("sha256").update(fs.readFileSync(tempArchive)).digest("hex");
			fs.renameSync(tempArchive, archive);
		} finally {
			fs.rmSync(tempArchive, { force: true });
		}
		mergeSums(outDir, name, `${digest}  ${name}`);
		console.log(`${digest}  ${name}`);
	});
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
