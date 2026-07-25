package com.atelier_nyaarium.switchboard.plugins.references

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * A small, display-only record of what each message's manifest said.
 *
 * Explicitly NOT authoritative. The authority is the manifest itself, read from the tapped row at
 * tap time, which is what gives references snapshot semantics and what makes a message drained
 * before this plugin existed still open correctly. This index exists only because two DISPLAY
 * decisions have to be made where reading a file is not allowed: whether an attachment chip is a
 * reference artifact (and so hidden), and whether a ref in the chat body renders amber. Both run at
 * transcript-serialization time on the main thread, where the contract is an in-memory lookup only.
 *
 * Seeded at drain time, where disk is allowed. A row drained before the plugin was enabled gets
 * plain visible chips and no amber, and there is no backfill, matching the chip-decoration posture.
 */
object RefDisplayIndex {
	private const val PREFS = "plugin-references-index"

	@Volatile private var prefs: SharedPreferences? = null

	/** team -> (messageAt -> summary). Held in memory because the serialization site cannot wait. */
	private val byTeam = HashMap<String, MutableMap<Long, Summary>>()

	/** What one message's manifest said, reduced to what display needs. */
	data class Summary(
		/** Attachment relative paths that are reference artifacts, so their chips are hidden. */
		val hiddenRels: Set<String>,
		/** Canonical ref key -> quality, for the chat-body tier. */
		val quality: Map<String, String>,
	)

	@Synchronized
	fun init(context: Context) {
		if (prefs != null) return
		val store = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
		prefs = store
		for ((key, value) in store.all) {
			if (value !is String) continue
			byTeam[key] = runCatching { decodeTeam(value) }.getOrDefault(HashMap())
		}
	}

	@Synchronized
	fun record(team: String, messageAt: Long, summary: Summary) {
		val existing = byTeam.getOrPut(team) { HashMap() }
		// Idempotent by construction: the mailbox delivers at least once, and a redelivered message
		// carries the same manifest, so rewriting the same summary is a no-op either way.
		existing[messageAt] = summary
		persist(team)
	}

	@Synchronized
	fun summaryFor(team: String, messageAt: Long): Summary? = byTeam[team]?.get(messageAt)

	/** Whether an attachment is a reference artifact this message brought along. */
	@Synchronized
	fun isArtifact(team: String, rel: String): Boolean =
		byTeam[team]?.values?.any { rel in it.hiddenRels } == true

	@Synchronized
	fun forget(team: String) {
		byTeam.remove(team)
		prefs?.edit()?.remove(team)?.apply()
	}

	@Synchronized
	fun forgetAll() {
		byTeam.clear()
		prefs?.edit()?.clear()?.apply()
	}

	private fun persist(team: String) {
		val rows = byTeam[team] ?: return
		val root = JSONObject()
		for ((at, summary) in rows) {
			root.put(
				at.toString(),
				JSONObject()
					.put("hidden", JSONArray(summary.hiddenRels.toList()))
					.put("quality", JSONObject(summary.quality.toMap())),
			)
		}
		prefs?.edit()?.putString(team, root.toString())?.apply()
	}

	private fun decodeTeam(raw: String): MutableMap<Long, Summary> {
		val root = JSONObject(raw)
		val out = HashMap<Long, Summary>()
		for (key in root.keys()) {
			val at = key.toLongOrNull() ?: continue
			val row = root.getJSONObject(key)
			val hidden = row.optJSONArray("hidden") ?: JSONArray()
			val quality = row.optJSONObject("quality") ?: JSONObject()
			out[at] = Summary(
				hiddenRels = (0 until hidden.length()).map { hidden.getString(it) }.toSet(),
				quality = quality.keys().asSequence().associateWith { quality.getString(it) },
			)
		}
		return out
	}
}
