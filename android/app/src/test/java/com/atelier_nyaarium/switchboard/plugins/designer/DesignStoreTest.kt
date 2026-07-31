package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Pins the additive index. Two layers: the PURE fold ([upsertInto]) that owns the latest-wins,
 * first-appearance ordering (no Context), and the singleton's observable behavior over a fake
 * SharedPreferences - upsert/delete reflect on the per-team flow, forget/forgetAll clear, and the
 * index survives a simulated process restart.
 */
class DesignStoreTest {

	private fun card(fileName: String, rel: String? = "1-1/$fileName", at: Long = 1000, group: String = "", blobId: String? = null) =
		StoredCard(fileName, rel, at, title = fileName.substringBeforeLast('.'), group = group, blobId = blobId)

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
		// A redelivered older revision must not overwrite a newer live-ingested pointer.
		val newer = upsertInto(emptyList(), card("a.html", rel = "1-9/a.html", at = 250))
		val stale = upsertInto(newer, card("a.html", rel = "1-2/a.html", at = 100))
		assertEquals("1-9/a.html", stale.single().rel)
	}

	@Test
	fun anEqualAtRedeliveryWithoutBytesKeepsWhatTheStoredEntryLearned() {
		// The re-drain fold can re-present a metadata-only copy of a message whose bytes already
		// landed; folding it in raw would forget the rel and blank the dock canvas.
		val landed = upsertInto(emptyList(), card("a.html", rel = "1-2/a.html", at = 100, blobId = "sha256-aa"))
		val redelivered = upsertInto(landed, card("a.html", rel = null, at = 100, blobId = null))
		assertEquals("1-2/a.html", redelivered.single().rel)
		assertEquals("sha256-aa", redelivered.single().blobId)
	}

	@Test
	fun aByteLessCardExistsAndFillsItsRelWhenTheSameAtRedeliversWithBytes() {
		val pending = upsertInto(emptyList(), card("a.html", rel = null, at = 100, blobId = "sha256-aa"))
		assertEquals(null, pending.single().rel)
		val landed = upsertInto(pending, card("a.html", rel = "1-2/a.html", at = 100, blobId = "sha256-aa"))
		assertEquals("1-2/a.html", landed.single().rel)
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
		DesignStore.forget("drop")
		assertTrue(DesignStore.cards("drop").value.isEmpty())
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
	fun cardForBlobFindsTheCurrentPushAndNeverAnOlderRevision() {
		DesignStore.upsert("t", card("a.html", at = 100, blobId = "sha256-old"))
		DesignStore.upsert("t", card("a.html", at = 250, blobId = "sha256-new"))
		assertEquals("a.html", DesignStore.cardForBlob("t", "sha256-new")?.fileName)
		assertEquals(null, DesignStore.cardForBlob("t", "sha256-old"))
	}

	@Test
	fun theIndexSurvivesAProcessRestart() {
		DesignStore.upsert("t", card("a.html", rel = "1-2/a.html", blobId = "sha256-aa"))
		// Drop the in-memory flows (simulated process death), then rebind the SAME prefs.
		DesignStore.resetForTest()
		DesignStore.init(context)
		assertEquals("1-2/a.html", DesignStore.cards("t").value.single().rel)
		assertEquals("sha256-aa", DesignStore.cards("t").value.single().blobId)
	}

	@Test
	fun aPreRoleStoredIndexStillLoads() {
		// The frozen legacy archive: cards persisted by the old build carry rel and no blobId, and
		// must hydrate unchanged rather than being lost on upgrade day.
		prefs.edit()
			.putString(
				"designs.t",
				"""[{"fileName":"old.html","rel":"1-1/old.html","at":500,"title":"Old","group":"Kit"}]""",
			)
			.apply()
		DesignStore.resetForTest()
		DesignStore.init(context)
		val loaded = DesignStore.cards("t").value.single()
		assertEquals("1-1/old.html", loaded.rel)
		assertEquals(null, loaded.blobId)
		assertEquals("Old", loaded.title)
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
