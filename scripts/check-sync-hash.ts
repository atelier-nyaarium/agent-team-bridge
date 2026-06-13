// Per-copy faithfulness guard for the synced leaf modules (notice.ts,
// evie-protocol.ts). Each file's header carries a `// SYNC-HASH: <sha256>` of
// its own body (everything except that line). The source and its verbatim
// copies all carry the same line, so this single check - run inside ANY repo
// holding the file - catches a hand-edit that diverged a copy from the hash it
// was cut at, even one that still type-checks. It does NOT diff across repos
// (a stale copy is caught at the next legitimate re-copy); that cross-repo job
// is deferred.
//
//   bun scripts/check-sync-hash.ts <file> [<file> ...]   # verify (default)
//   bun scripts/check-sync-hash.ts --write <file> ...    # stamp the source
//
// Workflow: edit the source, run with --write, then cp to the copies (the
// stamped hash rides along). CI runs verify mode on the source and every copy.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

////////////////////////////////
//  Functions & Helpers

const MARKER = "// SYNC-HASH:";

/** sha256 of the file body - every line except the SYNC-HASH marker line. */
function bodyHash(lines: string[]): string {
	const body = lines.filter((line) => !line.startsWith(MARKER)).join("\n");
	return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

/** Stamp (or restamp) the marker line right after the first comment line. */
function stamp(file: string): void {
	const lines = readFileSync(file, "utf8").split("\n");
	const withoutMarker = lines.filter((line) => !line.startsWith(MARKER));
	const hash = bodyHash(withoutMarker);
	// Insert the marker as the very first line so it travels with a verbatim cp.
	const stamped = [`${MARKER} ${hash}`, ...withoutMarker].join("\n");
	writeFileSync(file, stamped);
	console.log(`stamped ${file} (${hash})`);
}

/** Verify the recorded marker matches the recomputed body hash. */
function verify(file: string): boolean {
	const lines = readFileSync(file, "utf8").split("\n");
	const markerLine = lines.find((line) => line.startsWith(MARKER));
	if (!markerLine) {
		console.error(`${file}: no ${MARKER} marker (run --write on the source, then re-copy)`);
		return false;
	}
	const recorded = markerLine.slice(MARKER.length).trim();
	const actual = bodyHash(lines);
	if (recorded !== actual) {
		console.error(`${file}: SYNC-HASH mismatch - the file was edited away from its synced source.`);
		console.error(`  recorded ${recorded}, actual ${actual}`);
		console.error(`  Fix: re-copy from the source named in the header (do not hand-edit a synced copy).`);
		return false;
	}
	return true;
}

////////////////////////////////
//  Main

const args = process.argv.slice(2);
const writeMode = args[0] === "--write";
const files = writeMode ? args.slice(1) : args;

if (files.length === 0) {
	console.error("usage: bun scripts/check-sync-hash.ts [--write] <file> ...");
	process.exit(2);
}

if (writeMode) {
	for (const file of files) stamp(file);
} else {
	const ok = files.map(verify).every(Boolean);
	if (ok) console.log(`sync-hash: ${files.length} file(s) faithful.`);
	process.exit(ok ? 0 : 1);
}
