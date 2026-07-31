import type { ChannelFile } from "../shared/types.js";

////////////////////////////////
//  Legacy role stamping
//
//  TODO(2026-09): remove this module and its two restore-callback calls in gateway/index.ts once
//  the J-R2 precondition check confirms zero role-less entries in the durable stores.
//
//  Durable state written before roles existed carries role-less file lists, and a strict decoder
//  (the phone's generated types once `role` becomes required) throws on the FIRST such entry it is
//  served - the poll cursor then never advances past it, which wedges the console permanently. This
//  stamps the meaning in at the restore boundary, once; after the next persist rewrites the
//  snapshots, it is a no-op forever.

////////////////////////////////
//  Functions & Helpers

/** The reserved manifest filename of the pre-role wire, alive here ONLY to classify entries that
 * were persisted under that convention. Nothing on the live path reads it. */
const LEGACY_MANIFEST_FILENAME = "switchboard-references.json";

/**
 * Stamp roles onto a pre-role file list using the convention it was written under: the author's own
 * attachments first, then the manifest under its reserved name, then the snapshots it described.
 * The manifest entry itself is DROPPED - the concept it carried no longer exists, and a retained
 * copy would sit in the durable stores forever as machinery nothing can read.
 *
 * A list where any entry already carries a role was written post-role and passes through untouched,
 * which is also what makes the stamp idempotent.
 */
export function stampLegacyRoles(files: ChannelFile[]): ChannelFile[] {
	if (files.length === 0 || files.some((f) => f.role)) return files;
	const manifestAt = files.findIndex((f) => f.filename === LEGACY_MANIFEST_FILENAME);
	return files
		.filter((_, i) => i !== manifestAt)
		.map((f, i) => ({
			...f,
			// Post-filter indexes: everything at or past the manifest's slot was a snapshot.
			role: manifestAt !== -1 && i >= manifestAt ? ("ref-snapshot" as const) : ("attachment" as const),
		}));
}

/** Walk any restored value and stamp every `files` array found on the shapes the durable stores
 * hold (mailbox entries, stored job results). Tolerant by design: restore inputs are raw casts. */
export function stampLegacyRolesDeep(value: unknown): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) stampLegacyRolesDeep(item);
		return;
	}
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.files) && record.files.every((f) => f && typeof f === "object" && "filename" in f)) {
		record.files = stampLegacyRoles(record.files as ChannelFile[]);
	}
	for (const child of Object.values(record)) stampLegacyRolesDeep(child);
}
