package com.atelier_nyaarium.switchboard

/**
 * Why a request exists. A PLAY is what a consumer sees and what the toggle acts on; a PRELOAD only
 * warms the cache. They are separate entries, so pre-generating a message cannot make it read as
 * playing, and a Play landing mid-preload starts audio instead of cancelling the warm-up. A purge
 * still reaches both, which is the reason a preload is registered at all.
 */
enum class PlaybackRole {
	PLAY,
	PRELOAD,
}

/**
 * One playback request's identity, minted at claim and carried through every lane hand-off rather
 * than re-derived. `gen` distinguishes a re-claim of the same entry from the claim it replaced, so a
 * hand-off that arrives late drives nothing.
 */
data class PlaybackId(
	val team: String,
	val at: Long,
	val tier: SttsPlayer.Tier?,
	val gen: Long,
	val role: PlaybackRole = PlaybackRole.PLAY,
)

/**
 * The result of ending one or more requests: the events to publish, and WHICH request lost the sound.
 * Naming it rather than saying yes/no is what lets the caller release only the player that request
 * owns: the decision is taken here, the effect runs later under a different lock, and in between a
 * newer request can have taken the sound.
 */
data class PlaybackDrop(val events: List<SttsPlayer.Event.Ended>, val soundingEnded: PlaybackId?) {
	companion object {
		val NONE = PlaybackDrop(emptyList(), null)
	}
}

/**
 * The request lifecycle with no playback in it: claim, sound, one terminal, nothing after.
 *
 * An ENTRY is (team, at, tier, role) and holds at most one live request, so a second claim for the
 * same entry is refused instead of racing it. Provider and voice belong to the caller's cache key,
 * never to identity, because two identities for one thing is what makes an abandon return a list.
 *
 * Which request is sounding lives here too. Split across two objects it needed two monitors, so a
 * bulk drop could release a newer generation's player while leaving its claim orphaned.
 */
class PlaybackRequests {
	private data class Entry(val team: String, val at: Long, val tier: SttsPlayer.Tier?, val role: PlaybackRole)

	private val live = mutableMapOf<Entry, PlaybackId>()
	private var sounding: PlaybackId? = null
	private var nextGen = 1L

	// When each team was last purged, stamped from the same counter as `gen`. A purge is an instant but
	// a producer spans one: it can sit between two claims while the delete lands, then claim again and
	// write into the directory that is already gone. Holding a live claim therefore does not mean the
	// work is still wanted; being NEWER than the last purge does.
	private val purgedAt = mutableMapOf<String, Long>()
	private var wipedAt = 0L

	private fun entryOf(id: PlaybackId) = Entry(id.team, id.at, id.tier, id.role)

	/** Null when this entry is already live: single-flight, and the running request is untouched. */
	@Synchronized
	fun claim(team: String, at: Long, tier: SttsPlayer.Tier?, role: PlaybackRole = PlaybackRole.PLAY): PlaybackId? {
		val entry = Entry(team, at, tier, role)
		if (live.containsKey(entry)) return null
		val id = PlaybackId(team, at, tier, nextGen++, role)
		live[entry] = id
		return id
	}

	/** Whether a purge has landed since `id` was claimed. A producer holding a live claim can still be
	 * unwanted: the sweep that dropped its siblings arrived while it held no claim at all. A producer
	 * that re-claims per work item must use [purgeStamp] instead, or each claim moves its own horizon
	 * past the purge it needed to see. */
	@Synchronized
	fun isStale(id: PlaybackId): Boolean = (purgedAt[id.team] ?: 0L) > id.gen || wipedAt > id.gen

	// Structural equality throughout, which is exact because `gen` is unique per claim. Reference
	// equality would read the same until someone copied an id, and a data class hands out copy().
	@Synchronized
	fun isLive(id: PlaybackId): Boolean = live[entryOf(id)] == id

	/** Whether a PLAY request is claimed for this entry, sounding or still synthesizing. This is what a
	 * toggle acts on, so a caller's "is it active" check must ask the same question. */
	@Synchronized
	fun isLive(team: String, at: Long, tier: SttsPlayer.Tier?): Boolean =
		live.containsKey(Entry(team, at, tier, PlaybackRole.PLAY))

	/** Whether any TIER of this message has a live PLAY request, sounding or still synthesizing. */
	@Synchronized
	fun isLiveForMessage(team: String, at: Long): Boolean =
		live.keys.any { it.team == team && it.at == at && it.role == PlaybackRole.PLAY }

	/** Whether this message is AUDIBLE. The play button toggles on this rather than on the claim,
	 * because a row gives the user no way to see a request that is still synthesizing: tapping one
	 * looks like asking for playback and would silently cancel instead. The claim-scoped toggle lands
	 * with the Loading / Playing / Queued button state. */
	@Synchronized
	fun isSoundingForMessage(team: String, at: Long): Boolean =
		sounding?.let { it.team == team && it.at == at } == true

	/** Mark `id` as the one sounding, returning the terminal of whatever it displaced. Null when `id`
	 * is no longer live, which means it was abandoned before reaching the player. */
	@Synchronized
	fun sound(id: PlaybackId): PlaybackDrop? {
		if (live[entryOf(id)] != id) return null
		val loser = sounding?.takeIf { it != id }
		val displaced = loser?.let { finish(it, SttsPlayer.Outcome.PREEMPTED) }
		sounding = id
		return PlaybackDrop(listOfNotNull(displaced), if (displaced != null) loser else null)
	}

	/** A Started only exists while the request is still live. Once its terminal has gone out, a
	 * trailing Started would leave the consumer believing an ended entry is still playing. */
	@Synchronized
	fun started(id: PlaybackId): SttsPlayer.Event.Started? =
		if (isLive(id)) SttsPlayer.Event.Started(id.team, id.at, id.tier, id.gen) else null

	/** The one terminal for `id`. Null when it already ended or a newer claim superseded it, so a
	 * request can never report twice and a stale hand-off reports nothing. */
	@Synchronized
	fun finish(id: PlaybackId, outcome: SttsPlayer.Outcome, reason: String? = null): SttsPlayer.Event.Ended? {
		val entry = entryOf(id)
		if (live[entry] != id) return null
		live.remove(entry)
		if (sounding == id) sounding = null
		return SttsPlayer.Event.Ended(id.team, id.at, id.tier, id.gen, outcome, reason)
	}

	/** Terminal for exactly this request. Entry-scoped endings are for a user gesture, which means
	 * "whatever is running there"; a request reporting its OWN failure must not end the generation
	 * that replaced it. */
	@Synchronized
	fun finishRequest(id: PlaybackId, outcome: SttsPlayer.Outcome, reason: String? = null): PlaybackDrop =
		drop(if (live[entryOf(id)] == id) listOf(id) else emptyList(), outcome, reason)

	/** Terminal for whatever generation is live under this entry. PLAY only: a toggle and an abandon
	 * both mean "the audio the user asked for", never the cache warm-up behind it. */
	@Synchronized
	fun finishEntry(
		team: String,
		at: Long,
		tier: SttsPlayer.Tier?,
		outcome: SttsPlayer.Outcome,
		reason: String? = null,
	): PlaybackDrop = drop(listOfNotNull(live[Entry(team, at, tier, PlaybackRole.PLAY)]), outcome, reason)

	@Synchronized
	fun finishSounding(outcome: SttsPlayer.Outcome): PlaybackDrop = drop(listOfNotNull(sounding), outcome)

	/** End this entry only if it is the one currently audible. The check and the act are one operation
	 * so a toggle cannot end whatever became audible in between, and an entry that is merely claimed
	 * is left alone: the user cannot see it, so a tap must not silently cancel it. */
	@Synchronized
	fun finishIfSounding(team: String, at: Long, tier: SttsPlayer.Tier?, outcome: SttsPlayer.Outcome): PlaybackDrop {
		val id = sounding?.takeIf { it.team == team && it.at == at && it.tier == tier } ?: return PlaybackDrop.NONE
		return drop(listOf(id), outcome)
	}

	/** End every live PLAY request for one message, whichever tier. The button toggles by message, and
	 * a stop scoped to whatever happens to be sounding ends a different message when the one tapped is
	 * still synthesizing. */
	@Synchronized
	fun finishMessage(team: String, at: Long, outcome: SttsPlayer.Outcome): PlaybackDrop =
		drop(live.values.filter { it.team == team && it.at == at && it.role == PlaybackRole.PLAY }.toList(), outcome)

	/** End every live request for one team. Cache deletion needs this: a request that is claimed but
	 * still synthesizing owns no player, so ending the sounding one cannot reach it, and its hand-off
	 * would otherwise recreate the directory just deleted. */
	@Synchronized
	fun finishTeam(team: String, outcome: SttsPlayer.Outcome): PlaybackDrop =
		drop(live.values.filter { it.team == team }.toList(), outcome)

	/** End a team's requests AND mark its cache deleted. Distinct from [finishTeam]: preempting a
	 * team's playback says nothing about its files, and stamping on a mere preempt makes an in-flight
	 * synthesis throw away audio it just paid for. */
	@Synchronized
	fun purgeTeam(team: String): PlaybackDrop {
		purgedAt[team] = nextGen++
		return finishTeam(team, SttsPlayer.Outcome.PREEMPTED)
	}

	@Synchronized
	fun finishAll(outcome: SttsPlayer.Outcome): PlaybackDrop = drop(live.values.toList(), outcome)

	@Synchronized
	fun purgeEverything(): PlaybackDrop {
		wipedAt = nextGen++
		return finishAll(SttsPlayer.Outcome.PREEMPTED)
	}

	/** The horizon a long producer captures ONCE, before its first claim. Re-reading it per work item
	 * moves the horizon forward and blinds it to a purge that landed in between. */
	@Synchronized
	fun purgeStamp(): Long = nextGen

	@Synchronized
	fun purgedSince(team: String, stamp: Long): Boolean =
		(purgedAt[team] ?: 0L) >= stamp || wipedAt >= stamp

	/** A PRELOAD is ended silently: it reports no terminal because no consumer ever saw it start, and
	 * an Ended for a message the user never played would clear the glyph of one they did. */
	@Synchronized
	private fun drop(ids: List<PlaybackId>, outcome: SttsPlayer.Outcome, reason: String? = null): PlaybackDrop {
		if (ids.isEmpty()) return PlaybackDrop.NONE
		val loser = ids.firstOrNull { it == sounding }
		val events = ids.mapNotNull { id ->
			finish(id, outcome, reason)?.takeIf { id.role == PlaybackRole.PLAY }
		}
		return PlaybackDrop(events, loser)
	}
}
