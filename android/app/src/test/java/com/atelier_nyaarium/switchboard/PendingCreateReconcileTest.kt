package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The create_session placeholder's reconcile decision: retire it the moment its expected session
 * shows up for real in a fresh teams() snapshot, or after it has been pending long enough to be
 * considered abandoned (a backgrounded launch failure rolls its record back server-side with no
 * push, so this timeout is the only way the client ever learns of that case).
 */
class PendingCreateReconcileTest {
	private fun pc(
		key: String = "k1",
		project: String = "recipe-app",
		label: String = "My Work",
		expectedTeamName: String? = "local.laptop.recipe-app.a1b2c3",
		createdAtMs: Long = 0,
	) = PendingCreate(key = key, project = project, label = label, expectedTeamName = expectedTeamName, createdAtMs = createdAtMs)

	@Test
	fun retiresAPlaceholderWhoseExpectedSessionNowExists() {
		val (retained, abandoned) = reconcilePendingCreateList(
			pending = listOf(pc()),
			knownTeamNames = setOf("local.laptop.recipe-app.a1b2c3"),
			now = 1_000,
			timeoutMs = 60_000,
		)
		assertTrue(retained.isEmpty())
		assertNull(abandoned)
	}

	@Test
	fun keepsAPlaceholderThatHasNeitherMatchedNorTimedOut() {
		val (retained, abandoned) = reconcilePendingCreateList(
			pending = listOf(pc(createdAtMs = 1_000)),
			knownTeamNames = emptySet(),
			now = 5_000,
			timeoutMs = 60_000,
		)
		assertEquals(1, retained.size)
		assertNull(abandoned)
	}

	@Test
	fun dropsAndReportsAPlaceholderThatTimedOutWithNoMatch() {
		val (retained, abandoned) = reconcilePendingCreateList(
			pending = listOf(pc(label = "Story", createdAtMs = 0)),
			knownTeamNames = emptySet(),
			now = 100_000,
			timeoutMs = 60_000,
		)
		assertTrue(retained.isEmpty())
		assertEquals("Story", abandoned?.label)
	}

	@Test
	fun aLateMatchPastTheTimeoutIsStillASuccessNotAnAbandonment() {
		// The session showed up right as the clock ran out - a late win still counts as a win.
		val (retained, abandoned) = reconcilePendingCreateList(
			pending = listOf(pc(createdAtMs = 0)),
			knownTeamNames = setOf("local.laptop.recipe-app.a1b2c3"),
			now = 100_000,
			timeoutMs = 60_000,
		)
		assertTrue(retained.isEmpty())
		assertNull(abandoned)
	}

	@Test
	fun aPlaceholderWithNoExpectedNameYetIsNeverMatchedButSurvivesUntilTimeout() {
		// updateCreateSession has not landed yet (the createSession() call is still in flight).
		val (retained, abandoned) = reconcilePendingCreateList(
			pending = listOf(pc(expectedTeamName = null, createdAtMs = 1_000)),
			knownTeamNames = setOf("local.laptop.recipe-app.a1b2c3"),
			now = 5_000,
			timeoutMs = 60_000,
		)
		assertEquals(1, retained.size)
		assertNull(abandoned)
	}

	@Test
	fun onlyOneAbandonmentIsReportedPerCallEvenWhenSeveralTimeOutTogether() {
		val (retained, abandoned) = reconcilePendingCreateList(
			pending = listOf(pc(key = "k1", label = "A", createdAtMs = 0), pc(key = "k2", label = "B", createdAtMs = 0)),
			knownTeamNames = emptySet(),
			now = 100_000,
			timeoutMs = 60_000,
		)
		assertTrue(retained.isEmpty())
		assertTrue(abandoned?.label == "A" || abandoned?.label == "B")
	}

	@Test
	fun unrelatedPlaceholdersAreUnaffectedByOneAnothersOutcome() {
		val (retained, abandoned) = reconcilePendingCreateList(
			pending = listOf(
				pc(key = "matched", expectedTeamName = "local.laptop.recipe-app.a1b2c3", createdAtMs = 1_000),
				pc(key = "still-waiting", expectedTeamName = "local.laptop.other-app.deadbe", createdAtMs = 1_000),
			),
			knownTeamNames = setOf("local.laptop.recipe-app.a1b2c3"),
			now = 5_000,
			timeoutMs = 60_000,
		)
		assertEquals(listOf("still-waiting"), retained.map { it.key })
		assertNull(abandoned)
	}
}
