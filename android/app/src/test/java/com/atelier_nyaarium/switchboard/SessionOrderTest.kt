package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for sessionOrder: the board's primary comparator (live first, then most recent
 * activity, then label). Pure function over ChatState, no Android context (no Robolectric).
 */
class SessionOrderTest {

	private fun team(name: String, status: String = Presence.AVAILABLE) = testTeam(name, status = status)

	private fun stateWith(
		teams: List<Team>,
		threads: Map<String, List<Message>> = emptyMap(),
		labels: Map<String, String> = emptyMap(),
	) = ChatState(teams = teams, threads = threads, labels = labels)

	private fun order(state: ChatState) = state.teams.sortedWith(sessionOrder(state)).map { it.name }

	@Test
	fun liveSessionsSortBeforeIdleOnesRegardlessOfActivityOrLabel() {
		val state = stateWith(
			teams = listOf(
				team("local.gw.idle.claude", status = "available"),
				team("local.gw.live.claude", status = "online"),
			),
			threads = mapOf("local.gw.idle.claude" to listOf(Message(fromMe = true, text = "x", at = 999L))),
		)
		assertEquals(listOf("local.gw.live.claude", "local.gw.idle.claude"), order(state))
	}

	@Test
	fun verifyingCountsAsLiveJustLikeOnline() {
		val state = stateWith(
			teams = listOf(
				team("local.gw.idle.claude", status = "available"),
				team("local.gw.booting.claude", status = "verifying"),
			),
		)
		assertEquals(listOf("local.gw.booting.claude", "local.gw.idle.claude"), order(state))
	}

	@Test
	fun withinTheSameLivenessMostRecentActivityWinsFirst() {
		val state = stateWith(
			teams = listOf(team("local.gw.proja.claude"), team("local.gw.projb.claude")),
			threads = mapOf(
				"local.gw.proja.claude" to listOf(Message(fromMe = true, text = "old", at = 100L)),
				"local.gw.projb.claude" to listOf(Message(fromMe = true, text = "new", at = 200L)),
			),
		)
		assertEquals(listOf("local.gw.projb.claude", "local.gw.proja.claude"), order(state))
	}

	@Test
	fun noActivityAtAllFallsBackToLabelOrder() {
		val state = stateWith(
			teams = listOf(
				team("local.gw.zebra.claude"),
				team("local.gw.apple.claude"),
			),
			labels = mapOf("local.gw.zebra.claude" to "Zebra Work", "local.gw.apple.claude" to "Apple Work"),
		)
		assertEquals(listOf("local.gw.apple.claude", "local.gw.zebra.claude"), order(state))
	}

	@Test
	fun labelTiebreakUsesTheSameLabelPrecedenceAsTheRestOfTheApp() {
		// A local rename override wins over the server-reported sessionLabel, same as label().
		val state = stateWith(
			teams = listOf(
				testTeam("local.gw.proja.claude", status = Presence.AVAILABLE, sessionLabel = "Zzz Server"),
				testTeam("local.gw.projb.claude", status = Presence.AVAILABLE, sessionLabel = "Aaa Server"),
			),
			labels = mapOf("local.gw.proja.claude" to "Aaa Local Override"),
		)
		assertEquals(listOf("local.gw.proja.claude", "local.gw.projb.claude"), order(state))
	}

	@Test
	fun activityOutranksLabelWhenTheyDisagree() {
		// zebra has the more recent activity but an alphabetically-later label than apple - activity
		// must still decide the order, proving the comparator's clause priority, not just its presence.
		val state = stateWith(
			teams = listOf(team("local.gw.zebra.claude"), team("local.gw.apple.claude")),
			threads = mapOf(
				"local.gw.zebra.claude" to listOf(Message(fromMe = true, text = "new", at = 200L)),
				"local.gw.apple.claude" to listOf(Message(fromMe = true, text = "old", at = 100L)),
			),
			labels = mapOf("local.gw.zebra.claude" to "Zzz", "local.gw.apple.claude" to "Aaa"),
		)
		assertEquals(listOf("local.gw.zebra.claude", "local.gw.apple.claude"), order(state))
	}

	@Test
	fun noLabelAtAllFallsBackToTheRawSessionLeaf() {
		// Neither team has a local override or a server sessionLabel - the realistic default state for
		// a freshly-seen session - so the label clause must fall through to the bare session leaf.
		val state = stateWith(teams = listOf(team("local.gw.beta.projy"), team("local.gw.alpha.projz")))
		assertEquals(listOf("local.gw.beta.projy", "local.gw.alpha.projz"), order(state))
	}
}
