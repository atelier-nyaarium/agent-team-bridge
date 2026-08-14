////////////////////////////////
//  Functions & Helpers

/** Byte-identical to Kotlin's `Attachments.safeName`, pinned by a cross-runtime vector. */
export function safeName(name: string): string {
	const base = name.split("/").pop()?.split("\\").pop()?.trim() ?? "";
	// Without `u` the class matches per UTF-16 unit and an astral character becomes TWO underscores.
	const cleaned = base.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/, "");
	return (cleaned === "" ? "file" : cleaned).slice(0, 120);
}

/** `used` must already hold the agent's OWN attachment names, or a snapshot takes one of theirs. */
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
