package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.content.SharedPreferences
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** One persisted card in the additive index: a POINTER to its attachment (`rel`) plus the small
 * metadata the gallery renders, never a copy of the bytes. */
@Serializable
data class StoredCard(
	val fileName: String,
	val rel: String,
	val at: Long,
	val title: String? = null,
	val group: String = "",
	val w: Int? = null,
	val h: Int? = null,
) {
	fun toCard(): DesignerCard =
		DesignerCard(fileName, title ?: fileName.substringBeforeLast('.'), rel, at, DsCardMeta(group, w, h))
}

/**
 * The Designer plugin's OWN per-team device store. This is NOT a framework-provided abstraction - the
 * framework owns `PluginRegistry`, not storage - so a future plugin needing its own store would lift
 * the generic seam out of this one, not reuse it as-is. It lives in the Designer's own
 * SharedPreferences file so it is never entangled with AppStateStore's provisioning/schema partitions.
 *
 * A process-global singleton (init once at plugin setup with the app context, then accessed
 * context-free): the poll-thread ingest handler and the UI dock share ONE per-team `StateFlow`, so
 * there is no split-brain between a service-side write and an activity-side read. The index is
 * ADDITIVE: an arriving dsCard `upsert`s `fileName -> pointer` (at-monotonic, so a slow re-scan cannot
 * overwrite a newer pointer); `delete` shrinks the list. It holds a pointer + small metadata, never a
 * copy of the bytes.
 *
 * There is NO per-message watermark: the inbound pipeline delivers each message exactly once, so a
 * deleted card's message is never re-read to re-add it. The only cursor-like state is a volatile
 * per-team removal generation the one-time dock backfill guards against (see `upsert`'s `guardGen`) so
 * a user removal beats a racing seed. That backfill + removal-guard dance carries no Designer vocabulary; it
 * is a general inbound-consumer pattern and a candidate to lift into the framework the day a second
 * inbound-consuming plugin needs its own removable per-team store.
 */
object DesignStore {
	private const val BACKFILL_PREFIX = "backfilled."

	private val lock = Any()
	private var prefs: SharedPreferences? = null
	private val flows = HashMap<String, MutableStateFlow<List<StoredCard>>>()

	// The removal generation a one-shot dock backfill guards against, so a user removal that races the
	// in-flight seed wins (the loop stops re-adding instead of resurrecting the removed card). PER TEAM
	// so a delete in one conversation cannot abort an unrelated conversation's backfill: `wipeGen` is a
	// global bumped only by `forgetAll` (aborts every backfill), `teamGen` is bumped by a team's own
	// delete/forget, and a team's generation is their sum. Volatile, not per-message, never ordering.
	private var wipeGen = 0
	private val teamGen = HashMap<String, Int>()

	private fun genOf(team: String): Int = wipeGen + (teamGen[team] ?: 0)

	/** Idempotent one-time setup (called from the Designer's `register`, which runs before any
	 * ingest handler can fire). */
	fun init(context: Context) = synchronized(lock) {
		if (prefs == null) prefs = context.applicationContext.getSharedPreferences("switchboard-designer", Context.MODE_PRIVATE)
	}

	/** The reactive card list for a conversation (the dock collects this). Lazily hydrated from
	 * prefs on first access, under the lock, so a poll-thread `upsert` and a UI read cannot create
	 * two flows for the same team. */
	fun cards(team: String): StateFlow<List<StoredCard>> = flowFor(team)

	/** The removal generation for [team] a backfill captures before seeding, to abort if a removal for
	 * that team (or a full wipe) races it. */
	fun removalGeneration(team: String): Int = synchronized(lock) { genOf(team) }

	/** The card whose LATEST push is exactly [rel], or null. Rel-keyed, never fileName-keyed: the
	 * index keeps one entry per fileName (the newest), so a fileName match with a different rel is
	 * an older revision and must NOT borrow the current card's identity. Reads the hydrated flow
	 * only (no disk), so it is safe from the main thread at transcript-serialization time. */
	fun cardForRel(team: String, rel: String): StoredCard? = synchronized(lock) {
		if (rel.isEmpty()) return@synchronized null
		flowFor(team).value.firstOrNull { it.rel == rel }
	}

	/** Add or replace a card by filename (at-monotonic, first-appearance order preserved). A backfill
	 * passes the [guardGen] it captured before seeding; if a removal for this team (delete/forget) or a
	 * full wipe (forgetAll) has since bumped the team's generation the seed is dropped, so a stale
	 * re-scan cannot resurrect a card the user just removed. The live pipeline passes no guard (a
	 * genuine new push always applies). */
	fun upsert(team: String, card: StoredCard, guardGen: Int? = null) = synchronized(lock) {
		if (guardGen != null && guardGen != genOf(team)) return@synchronized
		val flow = flowFor(team)
		val next = upsertInto(flow.value, card)
		flow.value = next
		write(team, next)
	}

	/** Remove a card (Delete shrinks the array). */
	fun delete(team: String, fileName: String) = synchronized(lock) {
		val flow = flowFor(team)
		val next = flow.value.filterNot { it.fileName == fileName }
		if (next.size != flow.value.size) {
			teamGen[team] = (teamGen[team] ?: 0) + 1
			flow.value = next
			write(team, next)
		}
	}

	/** Drop a conversation's cards (thread forget), flow + prefs together. */
	fun forget(team: String) = synchronized(lock) {
		teamGen[team] = (teamGen[team] ?: 0) + 1
		flows[team]?.let { it.value = emptyList() }
		prefs?.edit()?.remove(key(team))?.remove(BACKFILL_PREFIX + team)?.apply()
	}

	/** Drop every conversation's cards (full account wipe). */
	fun forgetAll() = synchronized(lock) {
		wipeGen++ // bumps every team's generation at once, aborting any in-flight backfill
		flows.values.forEach { it.value = emptyList() }
		prefs?.edit()?.clear()?.apply()
	}

	/** Whether this conversation's one-time backfill has run (the dock seeds existing cards once). */
	fun hasBackfilled(team: String): Boolean = synchronized(lock) { prefs?.getBoolean(BACKFILL_PREFIX + team, false) ?: false }

	fun markBackfilled(team: String) = synchronized(lock) { prefs?.edit()?.putBoolean(BACKFILL_PREFIX + team, true)?.apply() }

	/** Test-only: drop the Context binding and cached flows so a suite gets isolation between cases,
	 * and can rebind the SAME prefs to exercise a persistence round-trip (a simulated process death). */
	@androidx.annotation.VisibleForTesting
	internal fun resetForTest() = synchronized(lock) {
		prefs = null
		flows.clear()
		wipeGen = 0
		teamGen.clear()
	}

	private fun flowFor(team: String): MutableStateFlow<List<StoredCard>> = synchronized(lock) {
		flows.getOrPut(team) { MutableStateFlow(read(team)) }
	}

	private fun read(team: String): List<StoredCard> =
		prefs?.getString(key(team), null)?.let {
			runCatching { wireJson.decodeFromString(ListSerializer(StoredCard.serializer()), it) }.getOrNull()
		} ?: emptyList()

	private fun write(team: String, cards: List<StoredCard>) {
		prefs?.edit()?.putString(key(team), wireJson.encodeToString(ListSerializer(StoredCard.serializer()), cards))?.apply()
	}

	private fun key(team: String) = "designs.$team"
}

/** Fold a card into the additive list: an existing entry with the same filename is REPLACED in place
 * (keeping its first-appearance slot), a new filename is APPENDED. The replace is at-monotonic - an
 * incoming card older than the stored one is ignored - so a slow dock backfill of an older revision
 * can never clobber a faster live-ingest of a newer one for the same filename. Pure, so the ordering
 * and monotonicity contract is pinned without a Context. */
internal fun upsertInto(cards: List<StoredCard>, card: StoredCard): List<StoredCard> {
	val byFile = LinkedHashMap<String, StoredCard>()
	cards.forEach { byFile[it.fileName] = it }
	val existing = byFile[card.fileName]
	if (existing == null || card.at >= existing.at) byFile[card.fileName] = card
	return byFile.values.toList()
}
