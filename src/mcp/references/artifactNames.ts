////////////////////////////////
//  Functions & Helpers

/**
 * The phone's own filename sanitizer, replicated.
 *
 * The console renames attachments as it writes them to disk. Naming a snapshot the way it will land
 * keeps the displayed name stable across the hop; nothing joins by name (a tapped ref pairs to its
 * snapshot through the file entry's own `ref` block). Kept byte-identical to `Attachments.safeName`
 * on the Kotlin side and pinned by a cross-runtime vector.
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
