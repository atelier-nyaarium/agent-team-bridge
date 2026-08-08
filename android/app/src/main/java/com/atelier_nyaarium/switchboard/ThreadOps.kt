package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/** [threadsAfterForget]'s result. `dropped` carries every removed row so a caller can clean up what
 * hung off them (attachment files) without a second, hand-copied sweep. */
internal data class ThreadsAfterForget(val threads: Map<String, List<Message>>, val dropped: List<Message>)

////////////////////////////////
//  Functions & Helpers

/** The thread map after forgetting `key`: drops its own thread, then sweeps every remaining thread
 * for a peer-mirror row naming `key` as either party. The gateway mirrors an agent-to-agent exchange
 * into BOTH participants' mailboxes, so dropping only `threads[key]` would leave the identical row
 * intact in the other participant's thread. */
internal fun threadsAfterForget(threads: Map<String, List<Message>>, key: String): ThreadsAfterForget {
	val dropped = mutableListOf<Message>()
	dropped += threads[key].orEmpty()
	val next = (threads - key).mapValues { (_, msgs) ->
		val (drop, keep) = msgs.partition { it.isPeer && (it.from == key || it.to == key) }
		dropped += drop
		keep
	}
	return ThreadsAfterForget(next, dropped)
}

/**
 * Whether a peer-mirrored message is the SECOND copy of one already claimed this poll pass. One
 * exchange reaches the burst loop twice, once per participant's thread, and would be spoken twice
 * over when both threads are followed.
 *
 * Keyed on CONTENT, not on `at`: the two copies do not share a timestamp, while body and files are
 * shared by both. Keying on `(from, to)` alone would collapse distinct exchanges between the same
 * pair, which matters now that a pass can queue more than one message.
 *
 * Residue: two IDENTICAL messages between the same pair in one burst collide and one is dropped.
 * Closing that needs a shared exchange id on the wire.
 */
internal fun isDuplicatePeerAutoPlay(message: Message?, seen: MutableSet<String>): Boolean {
	val peer = message?.takeIf { it.isPeer } ?: return false
	val files = peer.files.joinToString(",") { "${it.name}:${it.size}" }
	return !seen.add("${peer.from}|${peer.to}|${peer.text.hashCode()}|${peer.text.length}|$files")
}

/**
 * Drops any team whose forget-tombstone has not yet passed `now`, masking a teams() snapshot that
 * was dispatched before a forget reached the server and resolves after the local removal.
 *
 * Bounded rather than confirmation-cleared: a snapshot can only confirm a team's absence, never its
 * own forget failing or a legitimate same-address recreate, so a tombstone that cleared only on
 * confirmation would hide either forever. Also prunes expired entries, the one deliberate mutation
 * in an otherwise pure function, so every caller gets the sweep for free.
 */
internal fun filterTombstoned(teams: List<Team>, forgottenUntil: MutableMap<String, Long>, now: Long): List<Team> {
	forgottenUntil.entries.removeIf { it.value <= now }
	return if (forgottenUntil.isEmpty()) teams else teams.filterNot { forgottenUntil.containsKey(it.name) }
}
