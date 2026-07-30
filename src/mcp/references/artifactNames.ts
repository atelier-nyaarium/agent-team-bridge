////////////////////////////////
//  Functions & Helpers

/** The manifest's filename. Reserved: an agent attachment claiming it is a hard error at compose
 * time, which is what keeps the name unclaimable by anything but the builder. */
export const MANIFEST_FILENAME = "switchboard-references.json";

/** The manifest's self-describing top-level key. A file bearing it is only ADOPTED as the manifest
 * if it also carries the reserved name and is the first such entry, so content alone can never get
 * a foreign file adopted. */
export const MANIFEST_MARKER = "switchboardReferences";

/**
 * Throw if a caller-chosen filename would claim the reserved name. EVERY producer of an outbound
 * ChannelFile has to call this, because a receiver splits a reply's file list on that name to find
 * where generated snapshots begin; one unguarded producer makes the split land in the wrong place
 * and silently swallow real files.
 *
 * Compared post-`safeName` because the console renames as it writes, so a name that only collides
 * after sanitizing still collides where it lands.
 */
export function assertNotReservedName(filename: string): void {
	if (safeName(filename) === MANIFEST_FILENAME) {
		throw new Error(`Attachment "${filename}" uses the reserved name ${MANIFEST_FILENAME}; rename it to send it`);
	}
}

/**
 * The phone's own filename sanitizer, replicated.
 *
 * The console renames attachments as it writes them to disk, so the manifest has to record the name
 * the file will land under rather than the one it was sent with. Kept byte-identical to
 * `Attachments.safeName` on the Kotlin side and pinned by a cross-runtime vector: if the two drift,
 * every manifest entry points at a file that is not there and the viewer silently finds nothing.
 */
export function safeName(name: string): string {
	const base = name.split("/").pop()?.split("\\").pop()?.trim() ?? "";
	// The `u` flag matters: without it the class matches per UTF-16 unit and turns one astral
	// character into TWO underscores, where Kotlin's per-code-point matching produces one.
	const cleaned = base.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/, "");
	return (cleaned === "" ? "file" : cleaned).slice(0, 120);
}

/**
 * Suffix a name so two files sanitizing to one basename do not overwrite each other.
 *
 * `used` must already hold the agent's OWN attachment names: dedup runs across the entire files
 * array, not just the snapshots, or a snapshot could take the name of a file the agent attached.
 */
export function uniqueName(name: string, used: Set<string>): string {
	if (!used.has(name)) {
		used.add(name);
		return name;
	}

	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	let i = 1;
	let candidate = `${stem}-${i}${ext}`;
	while (used.has(candidate)) {
		i++;
		candidate = `${stem}-${i}${ext}`;
	}
	used.add(candidate);
	return candidate;
}
