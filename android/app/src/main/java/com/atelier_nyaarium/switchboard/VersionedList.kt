package com.atelier_nyaarium.switchboard

// Twin of src/shared/versioned-list.ts, pinned by tests/fixtures/versioned-list/vectors.json.

/** A Router answer: a full list when `since` is 0, else the entries changed after `since`. */
data class VersionedList<T>(val revision: Long, val since: Long, val entries: List<T>)

sealed interface VersionedFold<out T> {
	/** The list to hold from now on. */
	data class Apply<T>(val revision: Long, val entries: List<T>) : VersionedFold<T>

	/** The Router is behind the held revision, or the delta rests on another one: list from zero. */
	data object Restart : VersionedFold<Nothing>

	/** A full list older than the held one: a late answer. */
	data object Ignore : VersionedFold<Nothing>
}

/** A full list replaces in its own order; a delta lands in held order, and an entry never moves backward. */
fun <T> foldVersionedList(
	heldRevision: Long,
	held: List<T>,
	incoming: VersionedList<T>,
	id: (T) -> String,
	revision: (T) -> Long,
): VersionedFold<T> {
	if (incoming.revision < heldRevision) return if (incoming.since == 0L) VersionedFold.Ignore else VersionedFold.Restart
	// The list itself, so a memo keyed on its identity survives the fold.
	if (incoming.since == 0L) return VersionedFold.Apply(incoming.revision, incoming.entries)
	if (incoming.since != heldRevision) return VersionedFold.Restart
	val merged = LinkedHashMap<String, T>(held.size + incoming.entries.size)
	for (entry in held) merged[id(entry)] = entry
	for (entry in incoming.entries) {
		val current = merged[id(entry)]
		if (current != null && revision(current) > revision(entry)) continue
		merged[id(entry)] = entry
	}
	return VersionedFold.Apply(incoming.revision, merged.values.toList())
}
