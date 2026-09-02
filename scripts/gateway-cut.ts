// The snapshot cut: one archive of DATA_DIR at an epoch, with the fence up, plus the sums that make
// it verifiable. The export JSON carries the logical state; this carries the bytes, blobs included.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fenced, useMigrationEpochFile } from "../src/shared/migration-fence.js";

const dataDir = process.env.DATA_DIR || "/app/data";

function argument(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`usage: bun run scripts/gateway-cut.ts --epoch <N> [--out <dir>]`);
	return value;
}

function main(): void {
	const epoch = Number(argument("--epoch"));
	if (!Number.isInteger(epoch) || epoch < 1) throw new Error(`invalid epoch: ${epoch}`);
	const outDir = process.argv.includes("--out") ? argument("--out") : dataDir;
	useMigrationEpochFile(dataDir);
	// Taken over live writers, the archive is torn: files inside it disagree with each other.
	if (!fenced()) throw new Error("migration fence is not up; refusing to cut live state");

	fs.mkdirSync(outDir, { recursive: true });
	const name = `cut-${epoch}.tar`;
	const archive = path.join(outDir, name);
	// Written outside DATA_DIR when --out says so; a cut of a directory containing itself is not one.
	if (path.resolve(path.dirname(archive)) === path.resolve(dataDir))
		console.warn(`[cut] writing into DATA_DIR; pass --out to keep the archive outside it`);
	execFileSync("tar", ["--create", "--file", archive, "--directory", dataDir, "--exclude", name, "."], {
		stdio: "inherit",
	});

	const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
	const sumsFile = path.join(outDir, "SHA256SUMS");
	// Appended, so one sums file covers the archive and the export beside it.
	const existing = fs.existsSync(sumsFile) ? fs.readFileSync(sumsFile, "utf8") : "";
	const kept = existing
		.split("\n")
		.filter((line) => line.trim() && !line.endsWith(` ${name}`))
		.join("\n");
	fs.writeFileSync(sumsFile, `${kept ? `${kept}\n` : ""}${digest}  ${name}\n`, { mode: 0o600 });
	console.log(`${digest}  ${name}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
