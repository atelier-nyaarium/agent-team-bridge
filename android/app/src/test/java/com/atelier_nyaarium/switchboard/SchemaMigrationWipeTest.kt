package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the migrateSchemaIfNeeded() wipe set (AppStateStore.SCHEMA_WIPE_KEYS): every grammar-bearing
 * pref (the thread/label/draft store keys and the mailbox sync cursor) is cleared on the one-shot
 * grammar migration. A new address-keyed pref forgotten here would survive the wipe carrying a
 * stale-grammar key, so each must appear in the wipe set. Pure-JVM (asserts the declared key list,
 * not runtime prefs, so no Android Context is needed).
 */
class SchemaMigrationWipeTest {
	private val wiped = AppStateStore.SCHEMA_WIPE_KEYS

	@Test
	fun wipesGrammarBearingKeys() {
		val mustWipe = listOf(
			"threads",
			"read_anchors",
			"labels",
			"drafts",
			"scheduled_sends",
			"team_absence_streak",
			"sync_epoch",
			"sync_acked",
			"sync_dropped",
		)
		for (k in mustWipe) assertTrue("$k must be wiped by migrateSchemaIfNeeded", k in wiped)
	}

	@Test
	fun theGrammarFloorIsPinnedSoOnlyADeliberateEditCanWipeHistory() {
		// The wipe is gated on GRAMMAR_VERSION, not on equality with CURRENT_SCHEMA_VERSION: raising
		// the current version for an added field must carry a store forward, never delete the owner's
		// transcript. A relational assertion cannot tell an accidental bump from a real grammar break
		// (a genuine break wants floor == current), so the floor is pinned to a literal instead.
		// Raising it deletes every stored thread on every install below the new floor. If that is the
		// intent, change the literal here too and say what grammar broke.
		assertEquals(3, AppStateStore.GRAMMAR_VERSION)
		assertTrue(
			"GRAMMAR_VERSION may never exceed CURRENT_SCHEMA_VERSION, or every install wipes forever",
			AppStateStore.GRAMMAR_VERSION <= AppStateStore.CURRENT_SCHEMA_VERSION,
		)
	}
}
