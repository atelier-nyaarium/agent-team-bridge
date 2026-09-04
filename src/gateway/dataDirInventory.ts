import fs from "node:fs";
import path from "node:path";
import { isAtomicTemp } from "../shared/atomic-write.js";

////////////////////////////////
//  Constants

/**
 * Every entry the gateway itself creates under DATA_DIR. `data-dir-inventory.test.ts` pins the
 * durable file names against the openers in source, so a store cannot be added or dropped without
 * this set moving with it.
 */
export const DATA_DIR_ENTRIES: ReadonlySet<string> = new Set([
	"blobs",
	"board-attachments",
	"federation",
	"inbox-claims",
	"schema-version",
	"migration-epoch",
	"board-idempotency.json",
	"console-capabilities.json",
	"daemon-capabilities.json",
	"op-idempotency.json",
	"owner-row-outbox.json",
	"pending-deliveries.json",
	"pending-jobs.json",
	"replay-guard.json",
	"session-resume.json",
]);

////////////////////////////////
//  Functions & Helpers

/** Entries nothing in this build opens. A writer's own temp files are not strangers. */
export function unrecognizedDataEntries(dir: string, known: ReadonlySet<string> = DATA_DIR_ENTRIES): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return entries.filter((name) => !known.has(name) && !isAtomicTemp(name)).sort();
}

/**
 * Report, never touch. An orphan here is a file a consumer stopped opening: the data is the owner's,
 * and only a schema bump deletes by name.
 */
export function reportUnrecognizedDataEntries(dir: string, known: ReadonlySet<string> = DATA_DIR_ENTRIES): string[] {
	const strangers = unrecognizedDataEntries(dir, known);
	for (const name of strangers) {
		let detail = "unreadable";
		try {
			const stat = fs.statSync(path.join(dir, name));
			detail = stat.isDirectory() ? "directory" : `${stat.size} bytes, modified ${stat.mtime.toISOString()}`;
		} catch {}
		console.warn(`[data-dir] unrecognized entry ${name} (${detail}); nothing in this build opens it`);
	}
	return strangers;
}
