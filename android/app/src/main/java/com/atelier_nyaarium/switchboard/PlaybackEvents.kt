package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.SttsPlayer.Outcome
import com.atelier_nyaarium.switchboard.SttsPlayer.Tier

/** Carries the (team, at, tier) it belongs to, so a consumer can attribute an outcome to the
 * entry that caused it. `tier` is null only for the settings voice sample, which is not a
 * message. `gen` names the REQUEST: minting and publishing are not one step, so a terminal can be
 * delivered after the Started of the request that replaced it, and without a generation a
 * consumer cannot tell that apart from its own request ending. */
sealed interface Event {
	val team: String
	val at: Long
	val tier: Tier?
	val gen: Long

	data class Started(
		override val team: String,
		override val at: Long,
		override val tier: Tier?,
		override val gen: Long,
	) : Event

	data class Ended(
		override val team: String,
		override val at: Long,
		override val tier: Tier?,
		override val gen: Long,
		val outcome: Outcome,
		val reason: String? = null,
	) : Event
}

fun interface Listener {
	fun onPlaybackEvent(event: Event)
}
