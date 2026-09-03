package com.atelier_nyaarium.switchboard.board

import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.BoardRefused
import com.atelier_nyaarium.switchboard.ClearsOnReprovision
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.localFieldOrSelf
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.rethrowIfCancellation
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.TaskBoardVersion
import java.io.File
import java.util.UUID
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.Json

/** Storage seam for tests. */
interface BoardStore {
	fun loadTaskBoard(): String?

	fun saveTaskBoard(json: String)

	fun loadGatewayId(): String
}

interface BoardWriter {
	suspend fun boardWrite(
		op: ConsoleOp,
		gatewayId: String,
		opId: String = UUID.randomUUID().toString(),
	): List<String>

	/** Presence check only. */
	suspend fun boardBytesReady(blobId: String, gatewayId: String): Boolean = true
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

	/** Unreadable storage cannot authorize deletion. Declared before [blob] for [load]. */
	@Volatile private var loadedCleanly = true
	@Volatile private var blob: BoardBlob = load()
	private val drainMutex = Mutex()

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
			loadedCleanly = true
			refusals.clear()
			revision.longValue++
		}
	}

	val knownVersion: TaskBoardVersion?
		get() = null

	private fun routeGatewayId(): String = store.loadGatewayId()

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
		return mergeBoardSnapshot(routerEntries(current), current.queue, gatewayId, now)
	}

	val routerRevision: Long
		get() = snapshot().routerRevision

	fun storedById(): Map<String, BoardStoredEntry> = snapshot().stored.associateBy { it.clear.id }

	/** Null before the device roots a Domain. */
	@Volatile var sealing: (() -> BoardSealing?)? = null

	fun snapshot(): BoardBlob = synchronized(stateLock) { blob }

	private fun routerEntries(current: BoardBlob): List<BoardEntry> {
		val open = sealing?.invoke() ?: return applyPending(emptyList(), current.pending)
		return applyPending(renderBoard(current.stored, open, current.text).entries, current.pending)
	}

	fun routerEntries(): List<BoardEntry> = routerEntries(snapshot())

	fun pendingWrites(): List<PendingWrite> = blob.pending

	fun enqueueWrite(intents: List<BoardIntent>, opId: String = java.util.UUID.randomUUID().toString()): String {
		mutate { it.copy(pending = it.pending + PendingWrite(opId, intents)) }
		return opId
	}

	/** Settle and retire atomically. */
	fun settleWrite(opId: String, revision: Long, entries: List<BoardStoredEntry>, at: Long = System.currentTimeMillis()) {
		synchronized(stateLock) {
			val landed = if (revision >= blob.routerRevision) {
				blob.copy(routerRevision = revision, stored = entries, lastRouterSyncAt = at)
			} else {
				blob
			}
			persist(landed.copy(pending = landed.pending.filterNot { it.opId == opId }))
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
		synchronized(stateLock) {
			if (revision < blob.routerRevision) return false
			persist(blob.copy(routerRevision = revision, stored = entries, lastRouterSyncAt = at))
			return true
		}
	}

	/** Cache rendered text across epoch rotation. */
	fun renderRouterBoard(sealing: BoardSealing): BoardRendered {
		val current = snapshot()
		val rendered = renderBoard(current.stored, sealing, current.text)
		if (rendered.cache != current.text) mutate { it.copy(text = rendered.cache) }
		return rendered
	}

	/** Retry threshold for row markers. */
	private val STRUGGLING_AFTER = 8

	fun strugglingEntries(): Set<String> =
		blob.queue.filter { it.attempts >= STRUGGLING_AFTER }.mapNotNull { entryIdOf(it.op) }.toSet()

	/** Include queued targets. */
	fun sourceGatewayIds(): List<String> =
		(listOf(routeGatewayId()) + snapshot().queue.map { it.gatewayId }).filter { it.isNotEmpty() }.distinct()

	fun lastSyncedAt(gatewayId: String): Long = snapshot().lastRouterSyncAt

	fun dismissRefusal(refusal: BoardRefusal) {
		refusals.remove(refusal)
		mutate { it.copy(notices = it.notices.filter { n -> n != refusal }) }
	}

	fun applySnapshot(
		gatewayId: String,
		entries: List<BoardEntry>,
		version: TaskBoardVersion?,
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

	fun enqueue(
		op: ConsoleOp,
		gatewayId: String,
		dependsOn: String? = null,
		sources: Map<String, String> = emptyMap(),
	): String {
		val opId = UUID.randomUUID().toString()
		mutate {
			it.copy(
				queue = it.queue +
					PendingBoardAction(opId, gatewayId, op, dependsOn, sources = sources),
			)
		}
		return opId
	}

	/** Attachment buckets protected from sweeping. */
	fun attachmentBuckets(): Set<String>? {
		// Include queued attachments.
		// Keep every known entry bucket.
		val current = snapshot()
		if (!loadedCleanly || current.routerRevision <= 0 || sealing?.invoke() == null) return null
		val fromEntries = routerEntries(current).map { Attachments.boardBucket(it.id) }
		val fromQueue = current.queue.filter { it.sources.isNotEmpty() }
			.mapNotNull { entryIdOf(it.op) }
			.map { Attachments.boardBucket(it) }
		val fromPending = current.pending.flatMap { write -> write.intents.map { Attachments.boardBucket(it.id) } }
		return (fromEntries + fromQueue + fromPending).toSet()
	}

	/** Forget supersedes queued edits. */
	fun dropQueuedForSession(gatewayId: String, team: String): Int {
		val key = sessionKeyOf(team)
		val mine = mergedEntries(gatewayId).filter { it.sessionId == key }.mapTo(mutableSetOf()) { it.id }
		if (mine.isEmpty()) return 0
		var dropped = 0
		mutate { blob ->
			var queue = blob.queue
			for (action in blob.queue) {
				if (action.gatewayId != gatewayId) continue
				if (boardEntryIdsOf(action.op).none { it in mine }) continue
				if (queue.none { it.opId == action.opId }) continue
				queue = abandonBoardAction(queue, action.opId)
				dropped++
			}
			blob.copy(queue = queue)
		}
		return dropped
	}

	/** Single-flight drain with independent gateway lanes. */
	suspend fun drain(client: BoardWriter) {
		if (blob.queue.isEmpty()) return
		// Skip overlapping drains.
		if (!drainMutex.tryLock()) return
		try {
			coroutineScope {
				for (gatewayId in blob.queue.map { it.gatewayId }.distinct()) {
					launch { drainLane(client, gatewayId) }
				}
			}
		} finally {
			drainMutex.unlock()
		}
	}

	private suspend fun drainLane(client: BoardWriter, gatewayId: String) {
		val tried = mutableSetOf<String>()
		while (true) {
			val action = eligibleBoardActions(blob.queue, STRUGGLING_AFTER).firstOrNull { it.gatewayId == gatewayId }
				?: return
			// One attempt per action per drain.
			if (!tried.add(action.opId)) return
			try {
				// Uploads count toward retry attempts.
				uploadSources(client, action)
				val dropped = client.boardWrite(action.op, action.gatewayId, action.opId)
				mutate { it.copy(queue = retireBoardAction(it.queue, action.opId)) }
				if (dropped.isNotEmpty()) {
					notice(BoardRefusal(entryIdOf(action.op), dropped.joinToString(", "), BoardNoticeKind.DROPPED))
				}
			} catch (e: BoardRefused) {
				DebugLog.log("Board", "action ${action.opId} refused: ${e.reason}")
				notice(BoardRefusal(entryIdOf(action.op), e.reason))
				// Refusal abandons dependents.
				mutate { it.copy(queue = abandonBoardAction(it.queue, action.opId)) }
			} catch (e: Exception) {
				// Cancellation is not a failed send.
				e.rethrowIfCancellation()
				val attempts = action.attempts + 1
				DebugLog.log("Board", "action ${action.opId} retrying (attempt $attempts): ${e.message?.take(80)}")
				mutate { blob ->
					blob.copy(queue = blob.queue.map { if (it.opId == action.opId) it.copy(attempts = attempts) else it })
				}
				return
			}
		}
	}

	private suspend fun uploadSources(client: BoardWriter, action: PendingBoardAction) {
		for ((blobId, source) in action.sources) {
			if (client.boardBytesReady(blobId, action.gatewayId)) continue
			// Missing local files may still be fetched.
			if (!File(source).exists()) {
				DebugLog.log("Board", "action ${action.opId} abandoned: ${source.substringAfterLast('/')} is gone")
				notice(BoardRefusal(entryIdOf(action.op), "that file is no longer on this device"))
				mutate { it.copy(queue = abandonBoardAction(it.queue, action.opId)) }
			}
			error("attachment $blobId is not on the Gateway yet")
		}
	}

	/** Queue order is behaviorally significant. */
	val queuedActions: List<PendingBoardAction>
		get() = blob.queue

	/** Entry id comes from the queued action. */
	fun pendingSources(): List<Triple<String, String, String>> =
		blob.queue.flatMap { action -> action.sources.map { (blobId, src) -> Triple(blobId, src, action.gatewayId) } }

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

	private fun entryIdOf(op: ConsoleOp): String? = when (op) {
		is ConsoleOp.BoardSetState -> op.id
		is ConsoleOp.BoardSetTitle -> op.id
		is ConsoleOp.BoardSetBody -> op.id
		is ConsoleOp.BoardSetParent -> op.id
		is ConsoleOp.BoardSetTrashed -> op.id
		is ConsoleOp.BoardSetSession -> op.id
		is ConsoleOp.BoardSetAttachments -> op.id
		is ConsoleOp.BoardUpsert -> op.entries.firstOrNull()?.id
		is ConsoleOp.BoardRemove -> op.ids.firstOrNull()
		else -> null
	}
}
