package com.atelier_nyaarium.switchboard

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
			"labels",
			"drafts",
			"team_absence_streak",
			"sync_epoch",
			"sync_acked",
			"sync_dropped",
		)
		for (k in mustWipe) assertTrue("$k must be wiped by migrateSchemaIfNeeded", k in wiped)
	}
}
