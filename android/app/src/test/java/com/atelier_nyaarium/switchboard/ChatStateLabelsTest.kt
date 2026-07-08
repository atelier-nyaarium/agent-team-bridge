package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Unit tests for ChatState.withFreshTeams: the local-label-override prune rule (a fresh
 * non-null server sessionLabel always wins) and the vanish-counter that eventually drops a local
 * override for a team that has stopped appearing in the teams list entirely.
 *
 * Pure data-class logic, no Android context (no Robolectric).
 */
class ChatStateLabelsTest {

	// -- Helper builders --

	private fun makeTeam(name: String, sessionLabel: String? = null) =
		Team(name = name, status = "online", mode = "channel", queueDepth = 0, sessionLabel = sessionLabel)

	// -- Local wins until the server has something to say --

	@Test
	fun localLabelWinsWhileTheServerHasNoLabelForIt() {
		val state = ChatState(labels = mapOf("proj.a" to "My Label"))
		val next = state.withFreshTeams(listOf(makeTeam("proj.a", sessionLabel = null)))
		assertEquals("My Label", next.labels["proj.a"])
		assertEquals(0, next.teamAbsenceStreaks["proj.a"] ?: 0)
	}

	// -- Self-heal: any fresh non-null server value drops the local override --

	@Test
	fun localLabelIsDroppedTheMomentAFreshServerValueLands() {
		val state = ChatState(labels = mapOf("proj.a" to "Stale Local Edit"))
		val next = state.withFreshTeams(listOf(makeTeam("proj.a", sessionLabel = "Server Value")))
		assertNull(next.labels["proj.a"])
	}

	@Test
	fun localLabelIsDroppedEvenWhenTheServerValueIsIdenticalToTheLocalOne() {
		// The rule is "a fresh value landed at all", not "landed and differs" - a local override
		// that happens to match the server exactly is still pruned, since the server is now
		// authoritative and there is nothing left for the local copy to protect.
		val state = ChatState(labels = mapOf("proj.a" to "Same Name"))
		val next = state.withFreshTeams(listOf(makeTeam("proj.a", sessionLabel = "Same Name")))
		assertNull(next.labels["proj.a"])
	}

	// -- Vanish counter: absence alone does not prune on the first miss --

	@Test
	fun aStillAbsentTeamDoesNotPruneOnOneMiss() {
		val state = ChatState(labels = mapOf("proj.gone" to "My Label"))
		val next = state.withFreshTeams(emptyList())
		assertEquals("My Label", next.labels["proj.gone"])
		assertEquals(1, next.teamAbsenceStreaks["proj.gone"])
	}

	@Test
	fun theStreakCrossesItsBoundAndPrunes() {
		var state = ChatState(labels = mapOf("proj.gone" to "My Label"))
		state = state.withFreshTeams(emptyList()) // miss 1
		assertEquals("My Label", state.labels["proj.gone"])
		state = state.withFreshTeams(emptyList()) // miss 2 - crosses the bound
		assertNull(state.labels["proj.gone"])
	}

	@Test
	fun reappearingResetsTheStreakBeforeItCrosses() {
		var state = ChatState(labels = mapOf("proj.a" to "My Label"))
		state = state.withFreshTeams(emptyList()) // miss 1
		assertEquals(1, state.teamAbsenceStreaks["proj.a"])
		// Reappears with no server label yet - the label survives and the streak resets, not merely
		// pauses: a LATER miss must count as a fresh miss 1, not a continuation toward the bound.
		state = state.withFreshTeams(listOf(makeTeam("proj.a", sessionLabel = null)))
		assertEquals("My Label", state.labels["proj.a"])
		assertEquals(0, state.teamAbsenceStreaks["proj.a"] ?: 0)
		state = state.withFreshTeams(emptyList()) // miss 1 again, not miss 2 - must not prune yet
		assertEquals("My Label", state.labels["proj.a"])
	}

	// -- The accepted same-device rename-race flicker self-corrects --

	@Test
	fun optimisticRenameSurvivesAPollThatHasNotCaughtUpYetThenSelfCorrects() {
		// rename() sets the local override optimistically before the server round trip resolves.
		var state = ChatState(labels = mapOf("proj.a" to "New Name"))
		// A poll that was already in flight lands with the OLD server value - the self-heal rule
		// cannot distinguish "stale" from "authoritative", so it drops the fresh optimistic edit for
		// one cycle. This is the accepted flicker, not a bug.
		state = state.withFreshTeams(listOf(makeTeam("proj.a", sessionLabel = "Old Name")))
		assertNull(state.labels["proj.a"])
		assertEquals("Old Name", state.label("proj.a"))
		// A later, ordinary poll picks up the server's own now-applied value directly through the
		// fresh teams list, not through a reinstated local override (ChatRepository.rename only
		// re-applies setLabel when the server's dedup changed the name; here it did not) - the
		// self-heal rule fires again, but teams itself now carries the correct label, so label()
		// resolves it correctly regardless.
		state = state.withFreshTeams(listOf(makeTeam("proj.a", sessionLabel = "New Name")))
		assertNull(state.labels["proj.a"])
		assertEquals("New Name", state.label("proj.a"))
	}
}
