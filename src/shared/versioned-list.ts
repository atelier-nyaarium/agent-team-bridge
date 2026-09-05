// The fold every Router-held list consumer applies; VersionedList.kt is the twin, pinned by shared vectors.

/** A Router answer: a full list when `since` is 0, else the entries changed after `since`. */
export interface VersionedList<T> {
	revision: number;
	since: number;
	entries: T[];
}

export interface VersionedHeld<T> {
	revision: number;
	entries: T[];
}

export interface VersionedKeys<T> {
	id: (entry: T) => string;
	revision: (entry: T) => number;
}

export type VersionedFold<T> =
	/** The list to hold from now on. */
	| { kind: "apply"; revision: number; entries: T[] }
	/** The Router is behind the held revision, or the delta rests on another one: list from zero. */
	| { kind: "restart" }
	/** A full list older than the held one: a late answer. */
	| { kind: "ignore" };

/** A full list replaces in its own order; a delta lands in held order, and an entry never moves backward. */
export function foldVersionedList<T>(
	held: VersionedHeld<T>,
	incoming: VersionedList<T>,
	keys: VersionedKeys<T>,
): VersionedFold<T> {
	if (incoming.revision < held.revision) return incoming.since === 0 ? { kind: "ignore" } : { kind: "restart" };
	if (incoming.since === 0) return { kind: "apply", revision: incoming.revision, entries: incoming.entries };
	if (incoming.since !== held.revision) return { kind: "restart" };
	const merged = new Map(held.entries.map((entry) => [keys.id(entry), entry]));
	for (const entry of incoming.entries) {
		const current = merged.get(keys.id(entry));
		if (current && keys.revision(current) > keys.revision(entry)) continue;
		merged.set(keys.id(entry), entry);
	}
	return { kind: "apply", revision: incoming.revision, entries: [...merged.values()] };
}
