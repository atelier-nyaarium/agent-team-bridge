import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../src/shared/atomic-write.js";
import { assertNoMigrationInProgress, MIGRATION_SETTLE_MS } from "../src/shared/migration-fence.js";

const dataDir = process.env.DATA_DIR || "/app/data";
const file = path.join(dataDir, "migration-epoch");

function usage(): never {
	throw new Error("usage: bun run gateway:fence --epoch <N> | --down");
}

function epochArgument(): number {
	const index = process.argv.indexOf("--epoch");
	const value = index < 0 ? undefined : process.argv[index + 1];
	if (!value || !/^[1-9][0-9]*$/.test(value)) usage();
	const epoch = Number(value);
	if (!Number.isSafeInteger(epoch)) usage();
	return epoch;
}

export function raiseFence(dataDir: string, epoch: number): void {
	const fenceFile = path.join(dataDir, "migration-epoch");
	if (fs.existsSync(fenceFile)) {
		const current = fs.readFileSync(fenceFile, "utf8").trim();
		if (!/^[1-9][0-9]*$/.test(current)) throw new Error("migration fence has malformed epoch");
		if (current !== String(epoch)) throw new Error(`migration fence already up at epoch ${current}`);
		return;
	}
	fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dataDir, 0o700);
	writeFileAtomic(fenceFile, `${epoch}\n`, { mode: 0o600 });
}

export function lowerFence(dataDir: string): void {
	const fenceFile = path.join(dataDir, "migration-epoch");
	if (!fs.existsSync(fenceFile)) throw new Error("migration fence is not up");
	if (!/^[1-9][0-9]*\n$/.test(fs.readFileSync(fenceFile, "utf8")))
		throw new Error("migration fence has malformed epoch");
	assertNoMigrationInProgress(dataDir);
	const age = Date.now() - fs.statSync(fenceFile).mtimeMs;
	if (age < MIGRATION_SETTLE_MS)
		throw new Error(`migration fence has not settled; refusing to remove while a cut may be in flight`);
	fs.rmSync(fenceFile);
}

if (import.meta.main) {
	try {
		const down = process.argv.includes("--down");
		console.log(`data ${path.resolve(dataDir)}`);
		if (down === process.argv.includes("--epoch") || (!down && !process.argv.includes("--epoch"))) usage();
		if (down) lowerFence(dataDir);
		else raiseFence(dataDir, epochArgument());
		console.log(down ? "migration fence down" : `migration fence up at epoch ${migrationEpochValue()}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

function migrationEpochValue(): string {
	return fs.readFileSync(file, "utf8").trim();
}
