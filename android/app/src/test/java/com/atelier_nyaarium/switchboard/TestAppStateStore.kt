package com.atelier_nyaarium.switchboard

import android.content.SharedPreferences
import java.io.File

internal fun testStore(): AppStateStore =
	AppStateStore(File("/tmp/switchboard-test"), TestPreferences(), encrypted = true)

internal fun plainStore(): AppStateStore =
	AppStateStore(File("/tmp/switchboard-test"), TestPreferences(), encrypted = false)

internal class TestPreferences : SharedPreferences {
	private val values = HashMap<String, Any?>()

	override fun getAll(): MutableMap<String, *> = values
	override fun getString(key: String?, defValue: String?): String? = values[key] as? String ?: defValue
	override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
		values[key] as? MutableSet<String> ?: defValues
	override fun getInt(key: String?, defValue: Int): Int = values[key] as? Int ?: defValue
	override fun getLong(key: String?, defValue: Long): Long = values[key] as? Long ?: defValue
	override fun getFloat(key: String?, defValue: Float): Float = values[key] as? Float ?: defValue
	override fun getBoolean(key: String?, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
	override fun contains(key: String?): Boolean = values.containsKey(key)
	override fun edit(): SharedPreferences.Editor = TestEditor(values)
	override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
	override fun unregisterOnSharedPreferenceChangeListener(
		listener: SharedPreferences.OnSharedPreferenceChangeListener?,
	) {}
}

private class TestEditor(private val values: HashMap<String, Any?>) : SharedPreferences.Editor {
	override fun putString(key: String?, value: String?): SharedPreferences.Editor = put(key, value)
	override fun putStringSet(key: String?, value: MutableSet<String>?): SharedPreferences.Editor = put(key, value)
	override fun putInt(key: String?, value: Int): SharedPreferences.Editor = put(key, value)
	override fun putLong(key: String?, value: Long): SharedPreferences.Editor = put(key, value)
	override fun putFloat(key: String?, value: Float): SharedPreferences.Editor = put(key, value)
	override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor = put(key, value)
	override fun remove(key: String?): SharedPreferences.Editor {
		values.remove(key)
		return this
	}
	override fun clear(): SharedPreferences.Editor {
		values.clear()
		return this
	}
	override fun apply() {}
	override fun commit(): Boolean = true

	private fun put(key: String?, value: Any?): SharedPreferences.Editor {
		values[key!!] = value
		return this
	}
}
