package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.content.SharedPreferences
import com.atelier_nyaarium.switchboard.plugins.PluginAction
import com.atelier_nyaarium.switchboard.plugins.PluginHost
import com.atelier_nyaarium.switchboard.plugins.PluginRuntime
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Pins the Designer's `designer:delete-card` plugin-action handler (plans/plugin-actions.md): it
 * claims the exact composite key the wire's `pluginId:actionType` bridges to, extracts `fileName`
 * from the opaque payload, and calls the already-idempotent `DesignStore.delete`. A malformed or
 * absent payload is a no-op, never a throw (the drain-loop bridge has no other backstop).
 */
class DesignerPluginActionTest {

	private val prefs = FakeActionPrefs()
	private val context = FakeActionContext(prefs)

	@Before
	fun bindFreshStoreAndPlugin() {
		DesignStore.resetForTest()
		DesignStore.upsert("t", StoredCard("editor-form.html", "1-1/editor-form.html", 1000))
	}

	private fun deleteHandler(): (PluginAction) -> Unit {
		val runtime = PluginRuntime()
		val host = PluginHost(runtime, context)
		DesignerPlugin().register(host)
		val handler = host.pluginActions.get("designer:delete-card")!!
		return { action -> handler.onAction(action) }
	}

	@Test
	fun deletesTheCardNamedInThePayload() {
		val onAction = deleteHandler()
		onAction(PluginAction("t", buildJsonObject { put("fileName", JsonPrimitive("editor-form.html")) }))
		assertTrue(DesignStore.cards("t").value.isEmpty())
	}

	@Test
	fun aRepeatDispatchOfTheSameActionIsASafeNoOp() {
		// The mandatory idempotency contract (PluginActionHandler's doc): at-least-once mailbox
		// delivery can redispatch the same action, and it must never throw or misbehave.
		val onAction = deleteHandler()
		val action = PluginAction("t", buildJsonObject { put("fileName", JsonPrimitive("editor-form.html")) })
		onAction(action)
		onAction(action)
		assertTrue(DesignStore.cards("t").value.isEmpty())
	}

	@Test
	fun missingOrNullFileNameIsANoOp() {
		val onAction = deleteHandler()
		onAction(PluginAction("t", buildJsonObject { }))
		onAction(PluginAction("t", buildJsonObject { put("fileName", JsonNull) }))
		onAction(PluginAction("t", payload = null))
		assertEquals(listOf("editor-form.html"), DesignStore.cards("t").value.map { it.fileName })
	}

	@Test
	fun aNonMatchingFileNameLeavesTheCardAlone() {
		val onAction = deleteHandler()
		onAction(PluginAction("t", buildJsonObject { put("fileName", JsonPrimitive("someone-elses-card.html")) }))
		assertEquals(listOf("editor-form.html"), DesignStore.cards("t").value.map { it.fileName })
	}

	@Test
	fun onlyActsOnTheTeamNamedInTheAction() {
		DesignStore.upsert("other", StoredCard("editor-form.html", "1-1/editor-form.html", 1000))
		val onAction = deleteHandler()
		onAction(PluginAction("t", buildJsonObject { put("fileName", JsonPrimitive("editor-form.html")) }))
		assertTrue(DesignStore.cards("t").value.isEmpty())
		assertEquals(listOf("editor-form.html"), DesignStore.cards("other").value.map { it.fileName })
	}
}

/** A concrete Context whose only live method is getSharedPreferences, returning the in-memory fake -
 * everything else on ContextWrapper(null) would NPE, which is fine: neither DesignStore.init nor
 * DesignerPlugin.register touches anything else on it. */
private class FakeActionContext(private val prefs: SharedPreferences) : android.content.ContextWrapper(null) {
	override fun getApplicationContext(): Context = this

	override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = prefs
}

/** In-memory SharedPreferences; only the String/Boolean/remove/clear surface DesignStore uses. */
private class FakeActionPrefs : SharedPreferences {
	private val map = HashMap<String, Any?>()

	override fun getString(key: String?, defValue: String?): String? = (map[key] as? String) ?: defValue

	override fun getBoolean(key: String?, defValue: Boolean): Boolean = (map[key] as? Boolean) ?: defValue

	override fun edit(): SharedPreferences.Editor = FakeActionEditor(map)

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

private class FakeActionEditor(private val map: HashMap<String, Any?>) : SharedPreferences.Editor {
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
