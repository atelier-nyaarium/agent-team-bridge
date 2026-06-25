// Atomically format -> restamp -> copy a synced-leaf module to its declared target(s).
//
// The synced leaves in src/shared/ are copied VERBATIM into sibling repos (evie-bot, nyaaskills)
// with a SYNC-HASH stamp over the body. The footgun this script closes: editing a leaf, copying it,
// THEN running `bun run lint:fix` (biome) reformats the SOURCE - so the stamp + the copy are now
// stale (a hand-cut hash that no longer matches the formatted body), and the sibling repo's CI
// fails on a hash mismatch. The only safe order is format -> restamp -> copy, and nothing enforced
// it. This script does all three in one shot, reading each target from the leaf's own header
// ("// MUST re-copy on change: cp <src> <dst>"), so a sync can never go half-done.
//
//   bun scripts/sync-leaf.ts src/shared/federation-lifecycle.ts [more leaves...]
//   bun scripts/sync-leaf.ts --all        # every leaf with a copy-target header

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Functions & Helpers

const SHARED_DIR = "src/shared";
const COPY_LINE = /MUST re-copy on change:\s*cp\s+(\S+)\s+(\S+)/;

/** Every src/shared/*.ts that declares a copy target (the synced leaves). */
function allLeaves(): string[] {
	return readdirSync(SHARED_DIR)
		.filter((f) => f.endsWith(".ts"))
		.map((f) => path.join(SHARED_DIR, f))
		.filter((f) => COPY_LINE.test(readFileSync(f, "utf8")));
}

/** The copy destination(s) declared in a leaf's header. */
function targetsOf(file: string): string[] {
	const text = readFileSync(file, "utf8");
	return text
		.split("\n")
		.map((line) => line.match(COPY_LINE))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => m[2]);
}

function run(cmd: string, args: string[]): void {
	execFileSync(cmd, args, { stdio: "inherit" });
}

////////////////////////////////
//  Main

const args = process.argv.slice(2);
const files = args.includes("--all") ? allLeaves() : args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
	console.error("usage: bun scripts/sync-leaf.ts <src/shared/leaf.ts> ...   (or --all)");
	process.exit(1);
}

let failed = false;
for (const file of files) {
	const targets = targetsOf(file);
	if (targets.length === 0) {
		console.error(`! ${file}: no "MUST re-copy on change: cp <src> <dst>" header - not a synced leaf`);
		failed = true;
		continue;
	}
	// 1. Format FIRST (the step that, run after a manual copy, would stale the copy). Same biome pass
	//    as `bun run lint:fix`, so a later lint:fix is a no-op and cannot re-stale the copy.
	run("bunx", ["biome", "check", "--write", file]);
	// 2. Restamp the SYNC-HASH over the now-final body.
	run("bun", ["scripts/check-sync-hash.ts", "--write", file]);
	// 3. Copy the byte-identical source to every declared target.
	for (const dst of targets) {
		run("cp", [file, dst]);
		console.log(`synced ${file} -> ${dst}`);
	}
}

if (failed) process.exit(1);
