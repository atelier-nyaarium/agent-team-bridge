package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Pins the additive index. Two layers: the PURE fold ([upsertInto]) that owns the latest-wins,
 * first-appearance ordering (no Context), and the singleton's observable behavior over a fake
 * SharedPreferences - upsert/delete reflect on the per-team flow, forget/forgetAll clear, the
 * backfilled flag latches, and the index survives a simulated process restart.
 */
class DesignStoreTest {

	private fun card(fileName: String, rel: String = "1-1/$fileName", at: Long = 1000, group: String = "") =
		StoredCard(fileName, rel, at, title = fileName.substringBeforeLast('.'), group = group)

	////////////////////////////////
	//  Pure fold (no Context)

	@Test
	fun upsertAppendsNewFilenamesInFirstAppearanceOrder() {
		val one = upsertInto(emptyList(), card("a.html"))
		val two = upsertInto(one, card("b.html"))
		assertEquals(listOf("a.html", "b.html"), two.map { it.fileName })
	}

	@Test
	fun sameFilenameReplacesInPlaceWithTheLatestPointer() {
		val start = upsertInto(upsertInto(emptyList(), card("a.html", rel = "1-1/a.html")), card("b.html"))
		val next = upsertInto(start, card("a.html", rel = "1-3/a.html"))
		assertEquals(listOf("a.html", "b.html"), next.map { it.fileName })
		assertEquals("1-3/a.html", next.first { it.fileName == "a.html" }.rel)
	}

	@Test
	fun aNewerCardReplacesAnOlderOneForTheSameFilename() {
		val older = upsertInto(emptyList(), card("a.html", rel = "1-2/a.html", at = 100))
		val fresh = upsertInto(older, card("a.html", rel = "1-9/a.html", at = 250))
		assertEquals("1-9/a.html", fresh.single().rel)
	}

	@Test
	fun anOlderCardDoesNotClobberANewerOneForTheSameFilename() {
		// A slow dock backfill of an older revision must not overwrite a newer live-ingested pointer.
		val newer = upsertInto(emptyList(), card("a.html", rel = "1-9/a.html", at = 250))
		val stale = upsertInto(newer, card("a.html", rel = "1-2/a.html", at = 100))
		assertEquals("1-9/a.html", stale.single().rel)
	}

	////////////////////////////////
	//  toCard mapping (no Context)

	@Test
	fun storedCardMapsToADesignerCardForTheUi() {
		val ui = StoredCard("a.html", "1-1/a.html", 1000, title = "Editor", group = "Kit", w = 400, h = 800).toCard()
		assertEquals("Editor", ui.name)
		assertEquals("1-1/a.html", ui.rel)
		assertEquals("Kit", ui.meta.group)
		assertEquals(400, ui.meta.width)
	}

	@Test
	fun aStoredCardWithoutATitleFallsBackToTheFilenameStem() {
		assertEquals("editor-form", StoredCard("editor-form.html", "1-1/editor-form.html", 1000).toCard().name)
	}

	////////////////////////////////
	//  Singleton behavior (fake SharedPreferences)

	private val prefs = FakePrefs()
	private val context = FakeContext(prefs)

	@Before
	fun bindFreshStore() {
		DesignStore.resetForTest()
		DesignStore.init(context)
	}

	@Test
	fun upsertReflectsOnThePerTeamFlow() {
		DesignStore.upsert("t", card("a.html"))
		DesignStore.upsert("t", card("b.html"))
		assertEquals(listOf("a.html", "b.html"), DesignStore.cards("t").value.map { it.fileName })
	}

	@Test
	fun deleteShrinksTheArrayAndOtherCardsRemain() {
		DesignStore.upsert("t", card("a.html"))
		DesignStore.upsert("t", card("b.html"))
		DesignStore.delete("t", "a.html")
		assertEquals(listOf("b.html"), DesignStore.cards("t").value.map { it.fileName })
	}

	@Test
	fun deleteDoesNotBringACardBackFromItsOldMessage() {
		// The store is additive with exactly-once delivery: a delete is final until a strictly-new
		// inbound re-upserts. Nothing re-scans the old message, so the array stays shrunk.
		DesignStore.upsert("t", card("a.html"))
		DesignStore.delete("t", "a.html")
		assertTrue(DesignStore.cards("t").value.isEmpty())
		// A later re-push (a fresh ingest) re-adds it.
		DesignStore.upsert("t", card("a.html", rel = "1-9/a.html"))
		assertEquals("1-9/a.html", DesignStore.cards("t").value.single().rel)
	}

	@Test
	fun forgetClearsOnlyTheNamedConversation() {
		DesignStore.upsert("keep", card("k.html"))
		DesignStore.upsert("drop", card("d.html"))
		DesignStore.markBackfilled("drop")
		DesignStore.forget("drop")
		assertTrue(DesignStore.cards("drop").value.isEmpty())
		assertFalse(DesignStore.hasBackfilled("drop"))
		assertEquals(listOf("k.html"), DesignStore.cards("keep").value.map { it.fileName })
	}

	@Test
	fun forgetAllClearsEveryConversation() {
		DesignStore.upsert("a", card("a.html"))
		DesignStore.upsert("b", card("b.html"))
		DesignStore.forgetAll()
		assertTrue(DesignStore.cards("a").value.isEmpty())
		assertTrue(DesignStore.cards("b").value.isEmpty())
	}

	@Test
	fun backfilledFlagLatchesPerTeam() {
		assertFalse(DesignStore.hasBackfilled("t"))
		DesignStore.markBackfilled("t")
		assertTrue(DesignStore.hasBackfilled("t"))
		assertFalse(DesignStore.hasBackfilled("other"))
	}

	@Test
	fun aGuardedSeedIsDroppedAfterARemovalRacesIt() {
		// Simulates the backfill loop: it captured the removal generation, then the user deleted the
		// card mid-seed. The guarded re-seed must NOT resurrect it.
		DesignStore.upsert("t", card("a.html"))
		val guardGen = DesignStore.removalGeneration("t")
		DesignStore.delete("t", "a.html")
		DesignStore.upsert("t", card("a.html"), guardGen = guardGen)
		assertTrue(DesignStore.cards("t").value.isEmpty())
	}

	@Test
	fun aForgetAlsoStopsAGuardedSeed() {
		val guardGen = DesignStore.removalGeneration("t")
		DesignStore.forget("t")
		DesignStore.upsert("t", card("a.html"), guardGen = guardGen)
		assertTrue(DesignStore.cards("t").value.isEmpty())
	}

	@Test
	fun forgetAllStopsAGuardedSeed() {
		val guardGen = DesignStore.removalGeneration("t")
		DesignStore.forgetAll()
		DesignStore.upsert("t", card("a.html"), guardGen = guardGen)
		assertTrue(DesignStore.cards("t").value.isEmpty())
	}

	@Test
	fun aRemovalInAnotherConversationDoesNotAbortThisTeamsSeed() {
		// The guard is per-team: a delete in conversation "a" must not drop conversation "b"'s backfill.
		val guardGen = DesignStore.removalGeneration("b")
		DesignStore.upsert("a", card("x.html"))
		DesignStore.delete("a", "x.html")
		DesignStore.upsert("b", card("y.html"), guardGen = guardGen)
		assertEquals(listOf("y.html"), DesignStore.cards("b").value.map { it.fileName })
	}

	@Test
	fun aGuardedSeedAppliesWhenNoRemovalRaced() {
		val guardGen = DesignStore.removalGeneration("t")
		DesignStore.upsert("t", card("a.html"), guardGen = guardGen)
		assertEquals(listOf("a.html"), DesignStore.cards("t").value.map { it.fileName })
	}

	@Test
	fun theIndexSurvivesAProcessRestart() {
		DesignStore.upsert("t", card("a.html", rel = "1-2/a.html"))
		DesignStore.markBackfilled("t")
		// Drop the in-memory flows (simulated process death), then rebind the SAME prefs.
		DesignStore.resetForTest()
		DesignStore.init(context)
		assertEquals("1-2/a.html", DesignStore.cards("t").value.single().rel)
		assertTrue(DesignStore.hasBackfilled("t"))
	}
}

////////////////////////////////
//  Fakes

/** A concrete Context whose only live method is getSharedPreferences, returning the in-memory fake.
 * ContextWrapper(null) means every other call would NPE, which is intended: the store touches none. */
private class FakeContext(private val prefs: SharedPreferences) : android.content.ContextWrapper(null) {
	override fun getApplicationContext(): Context = this

	override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = prefs
}

/** In-memory SharedPreferences. Only the String/Boolean/remove/clear surface the store uses is real;
 * the rest satisfy the interface. */
private class FakePrefs : SharedPreferences {
	private val map = HashMap<String, Any?>()

	override fun getString(key: String?, defValue: String?): String? = (map[key] as? String) ?: defValue

	override fun getBoolean(key: String?, defValue: Boolean): Boolean = (map[key] as? Boolean) ?: defValue

	override fun edit(): SharedPreferences.Editor = FakeEditor(map)

	override fun getAll(): MutableMap<String, *> = map

	override fun getInt(key: String?, defValue: Int): Int = (map[key] as? Int) ?: defValue

	override fun getLong(key: String?, defValue: Long): Long = (map[key] as? Long) ?: defValue

	override fun getFloat(key: String?, defValue: Float): Float = (map[key] as? Float) ?: defValue

	@Suppress("UNCHECKED_CAST")
	override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
		(map[key] as? MutableSet<String>) ?: defValues

	override fun contains(key: String?): Boolean = map.containsKey(key)

	override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}

	override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
}

private class FakeEditor(private val map: HashMap<String, Any?>) : SharedPreferences.Editor {
	override fun putString(key: String?, value: String?): SharedPreferences.Editor {
		map[key!!] = value
		return this
	}

	override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor {
		map[key!!] = value
		return this
	}

	override fun remove(key: String?): SharedPreferences.Editor {
		map.remove(key)
		return this
	}

	override fun clear(): SharedPreferences.Editor {
		map.clear()
		return this
	}

	override fun apply() {}

	override fun commit(): Boolean = true

	override fun putStringSet(key: String?, values: MutableSet<String>?): SharedPreferences.Editor {
		map[key!!] = values
		return this
	}

	override fun putInt(key: String?, value: Int): SharedPreferences.Editor {
		map[key!!] = value
		return this
	}

	override fun putLong(key: String?, value: Long): SharedPreferences.Editor {
		map[key!!] = value
		return this
	}

	override fun putFloat(key: String?, value: Float): SharedPreferences.Editor {
		map[key!!] = value
		return this
	}
}
