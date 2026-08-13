package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for `filterTombstoned`, the guard that masks the forget/board-resurrection race: a
 * wholesale teams() snapshot dispatched before `SessionOps.forget()` reaches the server can
 * still resolve carrying the just-forgotten team, which would otherwise overwrite the optimistic
 * local removal and bring the tile back. Bounded by a TTL rather than cleared on confirmation, since
 * a confirming snapshot never arrives for a failed forget or a same-address recreate.
 *
 * Pure function logic, no Android context (no Robolectric).
 */
class ForgetTombstoneTest {

	private fun makeTeam(name: String, status: String = "online") =
		Team(name = name, status = status, mode = "channel", queueDepth = 0)

	@Test
	fun masksATombstonedTeamStillWithinItsTtl() {
		val forgotten = mutableMapOf("proj.a" to 1_000L)
		val fresh = listOf(makeTeam("proj.a"), makeTeam("proj.b"))

		val result = filterTombstoned(fresh, forgotten, now = 500L)

		assertEquals(listOf("proj.b"), result.map { it.name })
	}

	@Test
	fun stopsMaskingOnceTheTtlHasPassed() {
		val forgotten = mutableMapOf("proj.a" to 1_000L)
		val fresh = listOf(makeTeam("proj.a"), makeTeam("proj.b"))

		val result = filterTombstoned(fresh, forgotten, now = 1_001L)

		assertEquals(
			"an expired tombstone must not mask a legitimate later snapshot (a same-address recreate, or the server's own delayed confirmation)",
			listOf("proj.a", "proj.b"),
			result.map { it.name },
		)
	}

	@Test
	fun prunesExpiredEntriesAsASideEffect() {
		val forgotten = mutableMapOf("proj.a" to 1_000L, "proj.b" to 5_000L)

		filterTombstoned(emptyList(), forgotten, now = 2_000L)

		assertFalse("expired entry must be pruned", forgotten.containsKey("proj.a"))
		assertTrue("unexpired entry must survive the sweep", forgotten.containsKey("proj.b"))
	}

	@Test
	fun leavesAnUntombstonedTeamUntouched() {
		val forgotten = mutableMapOf("proj.other" to 1_000L)
		val fresh = listOf(makeTeam("proj.a"))

		val result = filterTombstoned(fresh, forgotten, now = 500L)

		assertEquals(listOf("proj.a"), result.map { it.name })
	}

	@Test
	fun maskingASnapshotThatAlreadyLacksTheTeamIsANoOp() {
		// The confirming snapshot itself never carries the forgotten team - filtering an
		// already-absent name must not error or otherwise perturb the list.
		val forgotten = mutableMapOf("proj.a" to 1_000L)
		val fresh = listOf(makeTeam("proj.b"))

		val result = filterTombstoned(fresh, forgotten, now = 500L)

		assertEquals(listOf("proj.b"), result.map { it.name })
	}

	@Test
	fun masksMultipleSimultaneouslyTombstonedTeams() {
		val forgotten = mutableMapOf("proj.a" to 1_000L, "proj.b" to 1_000L)
		val fresh = listOf(makeTeam("proj.a"), makeTeam("proj.b"), makeTeam("proj.c"))

		val result = filterTombstoned(fresh, forgotten, now = 500L)

		assertEquals(listOf("proj.c"), result.map { it.name })
	}

	@Test
	fun aSameAddressRecreateIsMaskedDuringTheTtlThenVisibleAfter() {
		// The exact scenario a confirmation-cleared tombstone gets wrong: the user forgets a team,
		// then recreates a session at the same canonical address before the TTL expires. A bounded
		// TTL still shows it, just delayed - never permanently hidden.
		val forgotten = mutableMapOf("proj.a" to 1_000L)
		val recreated = listOf(makeTeam("proj.a", status = "verifying"))

		val duringTtl = filterTombstoned(recreated, forgotten, now = 999L)
		assertTrue("recreate is masked while the tombstone is still active", duringTtl.isEmpty())

		val afterTtl = filterTombstoned(recreated, forgotten, now = 1_000L)
		assertEquals(
			"recreate becomes visible the instant the tombstone expires, not hidden forever",
			listOf("proj.a"),
			afterTtl.map { it.name },
		)
	}
}
