package com.atelier_nyaarium.switchboard.board

import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.ClearsOnReprovision
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.localFieldOrSelf
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import kotlinx.serialization.json.Json

/** Storage seam for tests. */
interface BoardStore {
	fun loadTaskBoard(): String?

	fun saveTaskBoard(json: String)

	fun loadGatewayId(): String
}

/** `currentId` identifies the displayed branch. */
data class BoardLiveLine(
	val title: String,
	val state: String,
	val finished: Int,
	val total: Int,
	val currentId: String? = null,
)

/** Pending edits overlay snapshots until accepted or refused. */
class BoardManager(private val store: BoardStore) : ClearsOnReprovision {
	private val json = Json { ignoreUnknownKeys = true }
	private data class RenderMemo(
		val stored: List<BoardStoredEntry>,
		val epochs: List<Int>,
		val rendered: BoardRendered,
	)

	/** Unreadable storage cannot authorize deletion. Declared before [blob] for [load]. */
	@Volatile private var loadedCleanly = true
	@Volatile private var blob: BoardBlob = load()
	@Volatile private var memo: RenderMemo? = null

	/** Guard every blob read-modify-write. */
	private val stateLock = Any()

	private fun mutate(transform: (BoardBlob) -> BoardBlob) {
		synchronized(stateLock) { persist(transform(blob)) }
	}

	val revision = mutableLongStateOf(0L)

	/** Persist notices from background drains. */
	val refusals = mutableStateListOf<BoardRefusal>()

	init {
		refusals.addAll(blob.notices)
	}

	private fun notice(entry: BoardRefusal) {
		refusals.add(entry)
		mutate { it.copy(notices = it.notices + entry) }
	}

	fun noticeRefusal(entryId: String?, reason: String) {
		notice(BoardRefusal(entryId, reason, BoardNoticeKind.REFUSED))
	}

	/** Durable key cleared first. */
	override suspend fun clearInMemory() {
		synchronized(stateLock) {
			blob = BoardBlob()
			memo = null
			loadedCleanly = true
			refusals.clear()
			revision.longValue++
		}
	}

	val knownVersion: Long?
		get() = null

	/** Empty or incomplete state cannot authorize deletion. */
	val boardIsKnown: Boolean
		get() = loadedCleanly && blob.routerRevision > 0

	private fun load(): BoardBlob {
		val raw = store.loadTaskBoard() ?: return BoardBlob()
		return runCatching { json.decodeFromString<BoardBlob>(raw) }.getOrNull()
			?: BoardBlob().also {
				loadedCleanly = false
				DebugLog.log("Board", "stored board could not be decoded; starting empty")
			}
	}

	private fun persist(next: BoardBlob) {
		if (next == blob) return
		blob = next
		store.saveTaskBoard(json.encodeToString(BoardBlob.serializer(), next))
		revision.longValue++
	}

	fun mergedEntries(gatewayId: String, now: Long = System.currentTimeMillis()): List<BoardEntry> {
		val current = snapshot()
		return routerEntries(current)
	}

	val routerRevision: Long
		get() = snapshot().routerRevision

	fun storedById(): Map<String, BoardStoredEntry> = snapshot().stored.associateBy { it.clear.id }

	/** Null before the device roots a Domain. */
	@Volatile var sealing: (() -> BoardSealing?)? = null

	fun snapshot(): BoardBlob = synchronized(stateLock) { blob }

	/** One decrypt per stored list and key set, outside the lock; the writers fill the memo first. */
	private fun routerEntries(current: BoardBlob): List<BoardEntry> {
		val open = sealing?.invoke() ?: return applyPending(emptyList(), current.pending)
		val hit = memo?.takeIf { it.stored === current.stored && it.epochs == open.epochs }
		val next = hit ?: render(open, current.stored, current.text).also { fresh ->
			synchronized(stateLock) {
				if (blob.stored === current.stored) {
					persist(blob.copy(text = fresh.rendered.cache))
					memo = fresh
				}
			}
		}
		return applyPending(next.rendered.entries, current.pending)
	}

	private fun render(open: BoardSealing, stored: List<BoardStoredEntry>, cache: Map<String, BoardCachedText>) =
		RenderMemo(stored, open.epochs, renderBoard(stored, open, cache))

	/** Null without a sealing. Rendered before any lock. */
	private fun renderIncoming(entries: List<BoardStoredEntry>): RenderMemo? =
		sealing?.invoke()?.let { render(it, entries, snapshot().text) }

	fun routerEntries(): List<BoardEntry> = routerEntries(snapshot())

	fun pendingWrites(): List<PendingWrite> = blob.pending

	fun enqueueWrite(intents: List<BoardIntent>, opId: String = java.util.UUID.randomUUID().toString()): String {
		mutate { it.copy(pending = it.pending + PendingWrite(opId, intents)) }
		return opId
	}

	/** Settle and retire atomically. */
	fun settleWrite(opId: String, revision: Long, entries: List<BoardStoredEntry>, at: Long = System.currentTimeMillis()) {
		val next = renderIncoming(entries)
		synchronized(stateLock) {
			val lands = revision >= blob.routerRevision
			val landed = if (lands) {
				blob.copy(
					routerRevision = revision,
					stored = entries,
					text = next?.rendered?.cache ?: blob.text,
					lastRouterSyncAt = at,
				)
			} else {
				blob
			}
			persist(landed.copy(pending = landed.pending.filterNot { it.opId == opId }))
			if (lands) memo = next
		}
	}

	fun retireWrite(opId: String) {
		mutate { blob -> blob.copy(pending = blob.pending.filterNot { it.opId == opId }) }
	}

	fun failWrite(opId: String) {
		mutate { blob ->
			blob.copy(pending = blob.pending.map { if (it.opId == opId) it.copy(attempts = it.attempts + 1) else it })
		}
	}

	/** Ignore older revisions. */
	fun applyRouterBoard(revision: Long, entries: List<BoardStoredEntry>, at: Long = System.currentTimeMillis()): Boolean {
		val next = renderIncoming(entries)
		synchronized(stateLock) {
			if (revision < blob.routerRevision) return false
			persist(
				blob.copy(
					routerRevision = revision,
					stored = entries,
					text = next?.rendered?.cache ?: blob.text,
					lastRouterSyncAt = at,
				),
			)
			memo = next
			return true
		}
	}

	/** Retry threshold for row markers. */
	fun strugglingEntries(): Set<String> = emptySet()

	/** Include queued targets. */
	fun sourceGatewayIds(homeGatewayId: String): List<String> = listOfNotNull(homeGatewayId.takeIf { it.isNotEmpty() })

	fun lastSyncedAt(gatewayId: String): Long = snapshot().lastRouterSyncAt

	fun dismissRefusal(refusal: BoardRefusal) {
		refusals.remove(refusal)
		mutate { it.copy(notices = it.notices.filter { n -> n != refusal }) }
	}

	fun applySnapshot(
		gatewayId: String,
		entries: List<BoardEntry>,
		version: Long?,
		truncated: Boolean,
		now: Long = System.currentTimeMillis(),
	) {
		return
	}

	/** Revocation prunes columns and queued writes. */
	fun retainGateways(admitted: Collection<String>) {
		if (admitted.isEmpty()) return
		return
	}

	/** Gateways with truncated snapshots. */
	fun truncatedGateways(): List<String> = emptyList()

	/** Attachment buckets protected from sweeping. */
	fun attachmentBuckets(): Set<String>? {
		// Include queued attachments.
		// Keep every known entry bucket.
		val current = snapshot()
		if (!loadedCleanly || current.routerRevision <= 0 || sealing?.invoke() == null) return null
		val fromEntries = routerEntries(current).map { Attachments.boardBucket(it.id) }
		val fromPending = current.pending.flatMap { write -> write.intents.map { Attachments.boardBucket(it.id) } }
		return (fromEntries + fromPending).toSet()
	}

	/** Convert team names to local keys. */
	fun sessionKeyOf(team: String): String = localFieldOrSelf(team)

	fun undoneCount(team: String): Int {
		val key = sessionKeyOf(team)
		return routerEntries().count {
			it.sessionId == key && it.trashedAt == null && it.state != "done" && it.state != "cancelled"
		}
	}

	/** Select in-progress, then open, by rank. */
	fun liveLine(team: String): BoardLiveLine? {
		val key = sessionKeyOf(team)
		val mine = routerEntries().filter { it.sessionId == key && it.trashedAt == null }
		if (mine.isEmpty()) return null
		val finished = mine.count { it.state == "done" || it.state == "cancelled" }
		val current = mine.filter { it.state == "in_progress" }.minByOrNull { it.rank }
			?: mine.filter { it.state == "open" }.minByOrNull { it.rank }
			?: mine.minByOrNull { it.rank }
		return BoardLiveLine(current?.title ?: "", current?.state ?: "open", finished, mine.size, current?.id)
	}

	fun cardBranch(gatewayId: String, team: String, currentId: String?, max: Int = CARD_BRANCH_MAX): CardBranch {
		val key = GroupKey(gatewayId, sessionKeyOf(team))
		val group = flattenBoard(routerEntries())
			.sessions.firstOrNull { it.key == key }
			?: return CardBranch(emptyList(), 0)
		return cardBranchOf(group.rows, currentId, max)
	}

}
