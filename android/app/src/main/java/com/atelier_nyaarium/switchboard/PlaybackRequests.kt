package com.atelier_nyaarium.switchboard

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executor

/**
 * One playback request's identity, minted at claim and carried through every lane hand-off rather
 * than re-derived. `gen` distinguishes a re-claim of the same entry from the claim it replaced, so a
 * hand-off that arrives late drives nothing.
 */
data class PlaybackId(val team: String, val at: Long, val tier: SttsPlayer.Tier?, val gen: Long)

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
 * An ENTRY is (team, at, tier) and holds at most one live request, so a second claim for the same
 * entry is refused instead of racing it. Provider and voice belong to the caller's cache key, never
 * to identity, because two identities for one thing is what makes an abandon return a list.
 *
 * Only PLAYBACK lives here. A cache warm-up holds no claim: it is not something a consumer can see,
 * stop, or advance a queue on, and giving it one made a message being pre-generated read as playing.
 * A purge reaches it through the epoch below instead, which covers it even between two of its writes,
 * where a claim could not.
 *
 * Which request is sounding lives here too. Split across two objects it needed two monitors, so a
 * bulk drop could release a newer generation's player while leaving its claim orphaned.
 *
 * Delivery lives here for the same reason. An event minted under this monitor but enqueued after it
 * was released could be overtaken by one minted later, so a `Started` could arrive behind its own
 * terminal. Appending inside the monitor makes delivery order the transition order by construction,
 * which is not something a consumer can be asked to reconstruct.
 *
 * `sink` is where delivery runs. The default runs inline, which is what a unit test wants; production
 * passes a single-thread lane so a listener cannot run under the monitor.
 */
class PlaybackRequests(private val sink: Executor = Executor { it.run() }) {
	private data class Entry(val team: String, val at: Long, val tier: SttsPlayer.Tier?)

	private val live = mutableMapOf<Entry, PlaybackId>()
	private var sounding: PlaybackId? = null
	private var nextGen = 1L

	// When each team was last purged, stamped from the same counter as `gen`. A purge is an instant but
	// a producer spans one: it can sit between two claims while the delete lands, then claim again and
	// write into the directory that is already gone. Holding a live claim therefore does not mean the
	// work is still wanted; being NEWER than the last purge does.
	private val purgedAt = mutableMapOf<String, Long>()
	private var wipedAt = 0L

	private val listeners = CopyOnWriteArrayList<SttsPlayer.Listener>()
	private val outbox = ArrayDeque<SttsPlayer.Event>()

	/** Add-once per subscriber; a duplicate add would double-deliver. Returns the listener so a caller
	 * that must later remove it can register a lambda without naming it twice. */
	fun addListener(listener: SttsPlayer.Listener): SttsPlayer.Listener {
		listeners.addIfAbsent(listener)
		return listener
	}

	fun removeListener(listener: SttsPlayer.Listener) {
		listeners.remove(listener)
	}

	/** Queue an event for delivery. Called only from inside the monitor, in the same critical section
	 * as the state change it reports. */
	private fun publish(event: SttsPlayer.Event?) {
		if (event != null) outbox.addLast(event)
	}

	/** Hand the queued events to the sink. The drain takes the monitor again and empties the WHOLE
	 * outbox, so order comes from append order and not from when a pump happens to run. */
	private fun pump() {
		sink.execute {
			val batch = synchronized(this) {
				val queued = outbox.toList()
				outbox.clear()
				queued
			}
			// A throwing listener is isolated rather than logged: this class stays free of Android
			// imports so its invariants can be unit-tested, and that rules out the platform logger.
			for (event in batch) {
				for (listener in listeners) runCatching { listener.onPlaybackEvent(event) }
			}
		}
	}

	private fun entryOf(id: PlaybackId) = Entry(id.team, id.at, id.tier)

	/** Null when this entry is already live: single-flight, and the running request is untouched. */
	@Synchronized
	fun claim(team: String, at: Long, tier: SttsPlayer.Tier?): PlaybackId? {
		val entry = Entry(team, at, tier)
		if (live.containsKey(entry)) return null
		val id = PlaybackId(team, at, tier, nextGen++)
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

	/** Whether a request is claimed for this entry, sounding or still synthesizing. This is what a
	 * toggle acts on, so a caller's "is it active" check must ask the same question. */
	@Synchronized
	fun isLive(team: String, at: Long, tier: SttsPlayer.Tier?): Boolean = live.containsKey(Entry(team, at, tier))

	/** Whether any TIER of this message is claimed, sounding or still synthesizing. */
	@Synchronized
	fun isLiveForMessage(team: String, at: Long): Boolean =
		live.keys.any { it.team == team && it.at == at }

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
	fun started(id: PlaybackId): SttsPlayer.Event.Started? {
		if (!isLive(id)) return null
		val event = SttsPlayer.Event.Started(id.team, id.at, id.tier, id.gen)
		publish(event)
		pump()
		return event
	}

	/** The one terminal for `id`. Null when it already ended or a newer claim superseded it, so a
	 * request can never report twice and a stale hand-off reports nothing. */
	@Synchronized
	fun finish(id: PlaybackId, outcome: SttsPlayer.Outcome, reason: String? = null): SttsPlayer.Event.Ended? {
		val entry = entryOf(id)
		if (live[entry] != id) return null
		live.remove(entry)
		if (sounding == id) sounding = null
		val event = SttsPlayer.Event.Ended(id.team, id.at, id.tier, id.gen, outcome, reason)
		publish(event)
		pump()
		return event
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
	): PlaybackDrop = drop(listOfNotNull(live[Entry(team, at, tier)]), outcome, reason)

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
		drop(live.values.filter { it.team == team && it.at == at }.toList(), outcome)

	/** End every live request for one team. Cache deletion needs this: a request that is claimed but
	 * still synthesizing owns no player, so ending the sounding one cannot reach it, and its hand-off
	 * would otherwise recreate the directory just deleted. */
	@Synchronized
	fun finishTeam(team: String, outcome: SttsPlayer.Outcome): PlaybackDrop =
		drop(live.values.filter { it.team == team }.toList(), outcome)

	/** End a team's requests apart from one entry. Superseding is "replace everything else", and doing
	 * it as a check then a sweep would let the sweep end the very entry the caller is about to claim,
	 * which costs a second synthesis for audio already being fetched. */
	@Synchronized
	fun finishTeamExcept(
		team: String,
		at: Long,
		tier: SttsPlayer.Tier?,
		outcome: SttsPlayer.Outcome,
	): PlaybackDrop = drop(live.values.filter { it.team == team && (it.at != at || it.tier != tier) }.toList(), outcome)

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

	/** `loser` is read before the loop, because finishing it clears the pointer it would be read from. */
	@Synchronized
	private fun drop(ids: List<PlaybackId>, outcome: SttsPlayer.Outcome, reason: String? = null): PlaybackDrop {
		if (ids.isEmpty()) return PlaybackDrop.NONE
		val loser = ids.firstOrNull { it == sounding }
		return PlaybackDrop(ids.mapNotNull { finish(it, outcome, reason) }, loser)
	}
}
