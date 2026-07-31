package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.content.SharedPreferences
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** One persisted card in the additive index: the wire-declared metadata the gallery renders plus a
 * POINTER to its attachment (`rel`, null until the bytes land), never a copy of the bytes. */
@Serializable
data class StoredCard(
	val fileName: String,
	val rel: String? = null,
	val at: Long,
	val title: String? = null,
	val group: String = "",
	val w: Int? = null,
	val h: Int? = null,
	/** Names the bytes on the blob plane, for the live-row rel derivation and the retry path. */
	val blobId: String? = null,
) {
	/** The rendered display name: the declared title, else the filename stem. Single owner of this
	 * rule so the dock (toCard) and the chip decorator can never drift on what a card is called. */
	val displayName: String get() = title ?: fileName.substringBeforeLast('.')

	fun toCard(resolvedRel: String? = rel, fetchFailed: Boolean = false): DesignerCard =
		DesignerCard(fileName, displayName, resolvedRel, at, DsCardMeta(group, w, h), blobId, fetchFailed)
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
 * ADDITIVE: an arriving dsCard `upsert`s by `fileName` (at-monotonic, so a redelivered older
 * revision cannot overwrite a newer one); `delete` shrinks the list.
 *
 * There is NO per-message watermark and NO removal guard: the inbound pipeline delivers each
 * message exactly once, strictly before the row can render, so no delete can precede the one write
 * a message ever causes. A deleted card's message is never re-read to re-add it.
 */
object DesignStore {
	private val lock = Any()
	private var prefs: SharedPreferences? = null
	private val flows = HashMap<String, MutableStateFlow<List<StoredCard>>>()

	/** Idempotent one-time setup (called from the Designer's `register`, which runs before any
	 * ingest handler can fire). */
	fun init(context: Context) = synchronized(lock) {
		if (prefs == null) prefs = context.applicationContext.getSharedPreferences("switchboard-designer", Context.MODE_PRIVATE)
	}

	/** The reactive card list for a conversation (the dock collects this). Lazily hydrated from
	 * prefs on first access, under the lock, so a poll-thread `upsert` and a UI read cannot create
	 * two flows for the same team. */
	fun cards(team: String): StateFlow<List<StoredCard>> = flowFor(team)

	/** The card whose LATEST push is exactly [rel], or null. Rel-keyed, never fileName-keyed: the
	 * index keeps one entry per fileName (the newest), so a fileName match with a different rel is
	 * an older revision and must NOT borrow the current card's identity. Reads the hydrated flow
	 * only (no disk), so it is safe from the main thread at transcript-serialization time. */
	fun cardForRel(team: String, rel: String): StoredCard? = synchronized(lock) {
		if (rel.isEmpty()) return@synchronized null
		flowFor(team).value.firstOrNull { it.rel == rel }
	}

	/** The card whose latest push names exactly these bytes, or null. Content-keyed, so an older
	 * revision (different bytes, different digest) never borrows the current card's identity - the
	 * same rule [cardForRel] enforces, on the wire-stable key that exists before the bytes land. */
	fun cardForBlob(team: String, blobId: String): StoredCard? = synchronized(lock) {
		flowFor(team).value.firstOrNull { it.blobId == blobId }
	}

	/** Add or replace a card by filename (at-monotonic, first-appearance order preserved). */
	fun upsert(team: String, card: StoredCard) = synchronized(lock) {
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
			flow.value = next
			write(team, next)
		}
	}

	/** Drop a conversation's cards (thread forget), flow + prefs together. */
	fun forget(team: String) = synchronized(lock) {
		flows[team]?.let { it.value = emptyList() }
		prefs?.edit()?.remove(key(team))?.apply()
	}

	/** Drop every conversation's cards (full account wipe). */
	fun forgetAll() = synchronized(lock) {
		flows.values.forEach { it.value = emptyList() }
		prefs?.edit()?.clear()?.apply()
	}

	/** Test-only: drop the Context binding and cached flows so a suite gets isolation between cases,
	 * and can rebind the SAME prefs to exercise a persistence round-trip (a simulated process death). */
	@androidx.annotation.VisibleForTesting
	internal fun resetForTest() = synchronized(lock) {
		prefs = null
		flows.clear()
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
 * incoming card older than the stored one is ignored - so a redelivered older revision can never
 * clobber a newer one for the same filename. An equal-at replace keeps whatever rel/blobId the
 * stored entry already learned, so a redelivered metadata-only copy cannot forget landed bytes.
 * Pure, so the ordering and monotonicity contract is pinned without a Context. */
internal fun upsertInto(cards: List<StoredCard>, card: StoredCard): List<StoredCard> {
	val byFile = LinkedHashMap<String, StoredCard>()
	cards.forEach { byFile[it.fileName] = it }
	val existing = byFile[card.fileName]
	if (existing == null || card.at > existing.at) {
		byFile[card.fileName] = card
	} else if (card.at == existing.at) {
		byFile[card.fileName] = card.copy(rel = card.rel ?: existing.rel, blobId = card.blobId ?: existing.blobId)
	}
	return byFile.values.toList()
}
