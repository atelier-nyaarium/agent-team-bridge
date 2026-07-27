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

	/** team -> the union of every summary's hiddenRels. Derived from [byTeam] and kept in step with
	 * it, purely so [isArtifact] is a set lookup rather than a scan of every message: it is called
	 * per file per row on EVERY transcript sync (serialization and the row fingerprint both), which
	 * a scan would make quadratic in a long thread. */
	private val hiddenByTeam = HashMap<String, MutableSet<String>>()

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
			reindex(key)
		}
	}

	@Synchronized
	fun record(team: String, messageAt: Long, summary: Summary) {
		val existing = byTeam.getOrPut(team) { HashMap() }
		// Idempotent by construction: the mailbox delivers at least once, and a redelivered message
		// carries the same manifest, so rewriting the same summary is a no-op either way.
		existing[messageAt] = summary
		hiddenByTeam.getOrPut(team) { HashSet() }.addAll(summary.hiddenRels)
		persist(team)
	}

	@Synchronized
	fun summaryFor(team: String, messageAt: Long): Summary? = byTeam[team]?.get(messageAt)

	/** Whether an attachment is a reference artifact this message brought along. */
	@Synchronized
	fun isArtifact(team: String, rel: String): Boolean = hiddenByTeam[team]?.contains(rel) == true

	/** Every rel this team has on record, for the artifact-chip trace: printed beside the rel the
	 * decorator is asking about, so a shape or team mismatch is visible without guessing. */
	@Synchronized
	fun knownRels(team: String): Set<String> = hiddenByTeam[team]?.toSet() ?: emptySet()

	@Synchronized
	fun forget(team: String) {
		byTeam.remove(team)
		hiddenByTeam.remove(team)
		prefs?.edit()?.remove(team)?.apply()
	}

	@Synchronized
	fun forgetAll() {
		byTeam.clear()
		hiddenByTeam.clear()
		prefs?.edit()?.clear()?.apply()
	}

	/** Rebuild one team's derived hidden-rel union from its summaries. */
	private fun reindex(team: String) {
		val rows = byTeam[team] ?: return
		hiddenByTeam[team] = rows.values.flatMapTo(HashSet()) { it.hiddenRels }
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
