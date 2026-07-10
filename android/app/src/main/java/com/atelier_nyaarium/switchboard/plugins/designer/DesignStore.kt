package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/**
 * The Designer plugin's own device store - the plugin framework's second real extension point
 * (per-plugin device storage), in its OWN SharedPreferences file so it is never entangled with
 * AppStateStore's provisioning/schema-wipe partitions.
 *
 * The store holds the ONLY design state that is not derivable from chat history: per-conversation
 * DELETE tombstones. Version history and card content are still derived from the message log +
 * on-disk attachments (see `designerCards`), so this stays tiny and the "derive, don't duplicate"
 * property survives. A tombstone records the newest-version timestamp at the moment of deletion;
 * `designerCards` hides a card whose newest version is not newer than its tombstone, so a
 * deliberate later re-push (a new revision) resurfaces it.
 *
 * All access is main-thread (UI actions); the delegated prefs are their own synchronization.
 */
class DesignStore(context: Context) {
	private val prefs = context.applicationContext.getSharedPreferences("switchboard-designer", Context.MODE_PRIVATE)

	/** Dismissed cards for one conversation: filename -> newest-version timestamp at delete time. */
	fun dismissed(team: String): Map<String, Long> =
		prefs.getString(key(team), null)?.let {
			runCatching { wireJson.decodeFromString(MAP, it) }.getOrNull()
		} ?: emptyMap()

	/** Tombstone [fileName] at [marker] (the card's current newest-version timestamp). */
	fun dismiss(team: String, fileName: String, marker: Long) {
		val next = dismissed(team) + (fileName to marker)
		prefs.edit().putString(key(team), wireJson.encodeToString(MAP, next)).apply()
	}

	/** Drop a card's tombstone (an explicit un-delete; a re-push resurfaces without this). */
	fun undismiss(team: String, fileName: String) {
		val next = dismissed(team) - fileName
		if (next.isEmpty()) {
			prefs.edit().remove(key(team)).apply()
		} else {
			prefs.edit().putString(key(team), wireJson.encodeToString(MAP, next)).apply()
		}
	}

	/** Forget a whole conversation's tombstones (wire into thread `forget()` if desired; a
	 * leftover tombstone for a gone thread is a benign orphan, so this is opportunistic). */
	fun forget(team: String) {
		prefs.edit().remove(key(team)).apply()
	}

	private fun key(team: String) = "dismissed.$team"

	private companion object {
		val MAP = MapSerializer(String.serializer(), Long.serializer())
	}
}
