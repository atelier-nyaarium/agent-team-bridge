// The typed-confirmation guard both purge paths (purgeGateway, purgeFederation) run before wiping
// the gateway volume, so an admin cannot silently destroy live task-board entries with a bare y/N.

import { ask, jparse } from "./lib/host.js";

////////////////////////////////
//  Functions & Helpers

/** Count live (non-trashed) task-board entries in the gateway's durable state. Shape mirrors
 * src/gateway/boardStore.ts's snapshot; a non-empty file this cannot read counts as UNKNOWN
 * (null), never as zero - a shape drift must not silently defeat the purge guard. */
export async function boardEntryCount(): Promise<number | null> {
	const raw = await Bun.file("volumes/gateway-data/task-board.json")
		.text()
		.catch(() => "");
	if (raw.trim() === "") return 0;
	const parsed = jparse<{ owners?: Record<string, { entries?: { trashedAt?: number }[] }> }>(raw);
	if (!parsed?.owners) return null;
	let n = 0;
	for (const owner of Object.values(parsed.owners)) {
		if (!Array.isArray(owner.entries)) return null;
		for (const e of owner.entries) if (e.trashedAt === undefined) n++;
	}
	return n;
}

/** A purge takes the task board with the volume. Refuse to proceed on a silent yes when live
 * entries exist: the admin must type the count they are destroying (or DELETE when the file is
 * unreadable and the count unknowable). */
export async function confirmBoardLoss(): Promise<boolean> {
	const n = await boardEntryCount();
	if (n === 0) return true;
	if (n === null) {
		console.log("A task-board file exists but could not be read. Purging deletes it.");
		return ask("Type DELETE to confirm: ").trim() === "DELETE";
	}
	console.log(`The task board holds ${n} live entr${n === 1 ? "y" : "ies"}. Purging deletes them.`);
	return ask(`Type ${n} to confirm: `).trim() === String(n);
}
