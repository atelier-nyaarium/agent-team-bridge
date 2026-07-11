package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.content.SharedPreferences
import com.atelier_nyaarium.switchboard.ChipDecoration
import com.atelier_nyaarium.switchboard.MessageFile
import com.atelier_nyaarium.switchboard.plugins.PluginHost
import com.atelier_nyaarium.switchboard.plugins.PluginRuntime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * Pins the Designer's `designer:card-title` chip decorator: a chip whose rel IS a card's current
 * push shows the card's title, and everything else keeps the plain chip. Rel-keyed matching is the
 * load-bearing rule - a fileName match with a DIFFERENT rel (an older revision of a re-pushed
 * card) must return null, never borrow the current revision's title.
 */
class DesignerChipDecoratorTest {

	private val prefs = FakeDecoPrefs()
	private val context = FakeDecoContext(prefs)

	@Before
	fun bindFreshStoreAndPlugin() {
		DesignStore.resetForTest()
	}

	private fun decorate(file: MessageFile, team: String = "t"): ChipDecoration? {
		val runtime = PluginRuntime()
		val host = PluginHost(runtime, context)
		DesignerPlugin().register(host)
		return host.attachmentChipDecorators.get("designer:card-title")!!.decorate(team, file)
	}

	private fun srcOf(rel: String) = "https://appassets.androidplatform.net/attachments/$rel"

	@Test
	fun aChipMatchingTheCardsCurrentPushShowsItsTitle() {
		DesignStore.upsert("t", StoredCard("editor-form.html", "1-1/editor-form.html", 1000, title = "Editor Form"))
		val deco = decorate(MessageFile("editor-form.html", "text/html", srcOf("1-1/editor-form.html")))
		assertEquals("Editor Form", deco?.title)
		assertEquals("designer", deco?.kind)
	}

	@Test
	fun aTitlelessCardFallsBackToTheFilenameStem() {
		DesignStore.upsert("t", StoredCard("editor-form.html", "1-1/editor-form.html", 1000))
		assertEquals("editor-form", decorate(MessageFile("editor-form.html", "text/html", srcOf("1-1/editor-form.html")))?.title)
	}

	@Test
	fun anOlderRevisionOfARepushedCardStaysAPlainChip() {
		// The store keeps only the LATEST rel per fileName; the historical chip's rel no longer
		// matches, and it must not borrow the newer revision's title.
		DesignStore.upsert("t", StoredCard("editor-form.html", "1-1/editor-form.html", 1000, title = "v1"))
		DesignStore.upsert("t", StoredCard("editor-form.html", "2-1/editor-form.html", 2000, title = "v2"))
		assertNull(decorate(MessageFile("editor-form.html", "text/html", srcOf("1-1/editor-form.html"))))
		assertEquals("v2", decorate(MessageFile("editor-form.html", "text/html", srcOf("2-1/editor-form.html")))?.title)
	}

	@Test
	fun aDeletedCardsChipStaysAPlainChip() {
		DesignStore.upsert("t", StoredCard("editor-form.html", "1-1/editor-form.html", 1000, title = "Editor Form"))
		DesignStore.delete("t", "editor-form.html")
		assertNull(decorate(MessageFile("editor-form.html", "text/html", srcOf("1-1/editor-form.html"))))
	}

	@Test
	fun aFileTheStoreNeverIngestedStaysAPlainChip() {
		assertNull(decorate(MessageFile("notes.html", "text/html", srcOf("1-1/notes.html"))))
		assertNull(decorate(MessageFile("photo.png", "image/png", srcOf("1-1/photo.png"))))
	}

	@Test
	fun aFileWithoutASourcePathStaysAPlainChip() {
		DesignStore.upsert("t", StoredCard("editor-form.html", "1-1/editor-form.html", 1000, title = "Editor Form"))
		assertNull(decorate(MessageFile("editor-form.html", "text/html", src = null)))
		assertNull(decorate(MessageFile("editor-form.html", "text/html", src = "https://elsewhere/no-attachments-segment")))
	}

	@Test
	fun decorationIsScopedToTheChipsOwnTeam() {
		DesignStore.upsert("t", StoredCard("editor-form.html", "1-1/editor-form.html", 1000, title = "Editor Form"))
		assertNull(decorate(MessageFile("editor-form.html", "text/html", srcOf("1-1/editor-form.html")), team = "other"))
	}
}

/** A concrete Context whose only live method is getSharedPreferences, returning the in-memory
 * fake; nothing else on ContextWrapper(null) is touched by DesignStore.init or register. */
private class FakeDecoContext(private val prefs: SharedPreferences) : android.content.ContextWrapper(null) {
	override fun getApplicationContext(): Context = this

	override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = prefs
}

/** In-memory SharedPreferences; only the String/Boolean/remove/clear surface DesignStore uses. */
private class FakeDecoPrefs : SharedPreferences {
	private val map = HashMap<String, Any?>()

	override fun getString(key: String?, defValue: String?): String? = (map[key] as? String) ?: defValue

	override fun getBoolean(key: String?, defValue: Boolean): Boolean = (map[key] as? Boolean) ?: defValue

	override fun edit(): SharedPreferences.Editor = FakeDecoEditor(map)

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

private class FakeDecoEditor(private val map: HashMap<String, Any?>) : SharedPreferences.Editor {
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
