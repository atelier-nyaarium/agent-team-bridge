package com.atelier_nyaarium.switchboard.board

import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import com.atelier_nyaarium.switchboard.BoardRefused
import com.atelier_nyaarium.switchboard.ConsoleClient
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.localFieldOrSelf
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.rethrowIfCancellation
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.TaskBoardVersion
import java.util.UUID
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json

/** The board's whole storage surface, so the manager is unit-testable without a Context.
 * [AppStateStore] implements it; see IdleSilenceStore for the same seam pattern. */
interface BoardStore {
	fun loadTaskBoard(): String?

	fun saveTaskBoard(json: String)

	fun loadGatewayId(): String
}

/** The one call the forget disposition makes, narrow enough for a test to stand in for the client. */
interface BoardWriter {
	suspend fun boardWrite(op: ConsoleOp, gatewayId: String, opId: String = UUID.randomUUID().toString())
}

/** One refused action's residue: the row marker's content, and the draft restore for an edit. */
data class BoardRefusal(val entryId: String?, val reason: String)

/** The one line a session card and thread strip show while board work exists. */
data class BoardLiveLine(val title: String, val state: String, val finished: Int, val total: Int)

/**
 * The console's board half: the per-Gateway cache, the pending-action queue, and the drain.
 *
 * Local-first: every edit enqueues and the UI reads [mergedEntries], which re-applies the queue
 * over the cache - so there is no online mode and no offline mode, and a poll snapshot landing
 * mid-edit cannot revert it. Queue entries retire ONLY on the gateway's accept or a sealed refusal
 * ([BoardRefused]); every other failure stays queued and retries on a later drain.
 */
class BoardManager(private val store: BoardStore) {
	private val json = Json { ignoreUnknownKeys = true }
	@Volatile private var blob: BoardBlob = load()
	private val drainMutex = Mutex()

	/** Every read-modify-write of [blob] goes through here. Mutations arrive from the main thread
	 * (a tap) and from Dispatchers.IO (the poll's snapshot apply and the drain), and an unguarded
	 * compound would drop whichever change lost the race - silently discarding a queued action and
	 * snapping the row back to Gateway truth. */
	private val stateLock = Any()

	private fun mutate(transform: (BoardBlob) -> BoardBlob) {
		synchronized(stateLock) { persist(transform(blob)) }
	}

	/** Bumped on every visible change; Compose reads it to re-derive rows. */
	val revision = mutableLongStateOf(0L)

	/** Refusals awaiting the owner's dismissal, newest last. Snapshot state, so a row marker appears
	 * the moment one lands rather than at some later unrelated recomposition. */
	val refusals = mutableStateListOf<BoardRefusal>()

	val knownVersion: TaskBoardVersion?
		get() = blob.gateways[routeGatewayId()]?.version

	private fun routeGatewayId(): String = store.loadGatewayId()

	private fun load(): BoardBlob =
		store.loadTaskBoard()?.let { raw ->
			runCatching { json.decodeFromString<BoardBlob>(raw) }.getOrNull()
		} ?: BoardBlob()

	private fun persist(next: BoardBlob) {
		if (next == blob) return
		blob = next
		store.saveTaskBoard(json.encodeToString(BoardBlob.serializer(), next))
		revision.longValue++
	}

	/** The board as the UI should see one Gateway: snapshot with the pending queue re-applied. */
	fun mergedEntries(gatewayId: String, now: Long = System.currentTimeMillis()): List<BoardEntry> =
		mergeBoardSnapshot(blob.gateways[gatewayId]?.entries ?: emptyList(), blob.queue, gatewayId, now)

	/** Failed sends after which a queued action is worth telling the owner about. It only changes what
	 * a row SAYS, never whether the action survives. */
	private val STRUGGLING_AFTER = 8

	/** Entry ids with a queued action that keeps failing to send. The row marks them, so a write that
	 * is retrying forever is visible rather than looking applied. */
	fun strugglingEntries(): Set<String> =
		blob.queue.filter { it.attempts >= STRUGGLING_AFTER }.mapNotNull { entryIdOf(it.op) }.toSet()

	/** Every Gateway the board must READ to render one truthful union: the ones holding a snapshot
	 * PLUS any a pending action targets. Without the second set, a move to a Gateway never yet
	 * read renders the entry zero times - the optimistic delete drops it from the origin while its
	 * upsert has no column to appear in. */
	fun sourceGatewayIds(): List<String> =
		(listOf(routeGatewayId()) + blob.gateways.keys + blob.queue.map { it.gatewayId }).filter { it.isNotEmpty() }.distinct()

	fun lastSyncedAt(gatewayId: String): Long = blob.gateways[gatewayId]?.lastSyncedAt ?: 0

	fun dismissRefusal(refusal: BoardRefusal) {
		refusals.remove(refusal)
	}

	/** A plane snapshot (route Gateway) or a board_read reply (any Gateway) landed. */
	fun applySnapshot(
		gatewayId: String,
		entries: List<BoardEntry>,
		version: TaskBoardVersion?,
		truncated: Boolean,
		now: Long = System.currentTimeMillis(),
	) {
		mutate { blob ->
			val prior = blob.gateways[gatewayId]?.entries ?: emptyList()
			// A truncated projection is an id-sorted PREFIX, so it is authoritative up to its own last
			// id and says nothing past it. Carrying forward only that tail is what keeps a deletion a
			// deletion: an id inside the covered range that the snapshot omits was removed, and
			// re-adding it would resurrect every moved-away entry and every swept trash row forever.
			val covered = entries.maxOfOrNull { it.id }
			val merged = if (!truncated || prior.isEmpty() || covered == null) {
				entries
			} else {
				entries + prior.filter { it.id > covered }
			}
			val next = GatewayBoard(entries = merged, version = version, truncated = truncated, lastSyncedAt = now)
			blob.copy(gateways = blob.gateways + (gatewayId to next))
		}
	}

	/** Gateways whose last snapshot was cut by the byte budget. The board says so rather than
	 * presenting a partial column as complete. */
	fun truncatedGateways(): List<String> = blob.gateways.filterValues { it.truncated }.keys.toList()

	/** Queue one mutation. The UI's next [mergedEntries] read already shows it applied. */
	fun enqueue(op: ConsoleOp, gatewayId: String, dependsOn: String? = null): String {
		val opId = UUID.randomUUID().toString()
		mutate { it.copy(queue = it.queue + PendingBoardAction(opId, gatewayId, op, dependsOn)) }
		return opId
	}

	/** The cross-Gateway move: the write half upserts the subtree on the target, and the delete
	 * half is LINKED so it cannot drain until the write's acceptance is recorded - per-Gateway
	 * lanes would otherwise let the delete land first and the entry exist nowhere. */
	fun enqueueMove(subtree: List<BoardEntry>, fromGateway: String, toGateway: String) {
		// Seed the destination as a known Gateway before either half is queued. Membership must not
		// depend on the queue: once the upsert is accepted and retired, a target with no snapshot
		// would drop out of the source list while the origin's delete still subtracts the entry, and
		// it would render nowhere at all.
		mutate { blob ->
			if (blob.gateways.containsKey(toGateway)) blob
			else blob.copy(gateways = blob.gateways + (toGateway to GatewayBoard()))
		}
		val writeId = enqueue(ConsoleOp.BoardUpsert(subtree), toGateway)
		enqueue(ConsoleOp.BoardRemove(subtree.map { it.id }), fromGateway, dependsOn = writeId)
	}

	/** Whether one Gateway's lane still holds work. The forget gate reads it after a drain: an op
	 * left behind would send after the disposition and overwrite the choice the owner just made. */
	fun hasQueuedOn(gatewayId: String): Boolean = blob.queue.any { it.gatewayId == gatewayId }

	/** Fire every eligible queued action once. Runs on the poll loop's cadence; single-flight so a
	 * slow lane cannot stack drains.
	 *
	 * Returns whether this call actually ran the lanes. False means a concurrent drain held them, so
	 * a caller that needs the queue FLUSHED (rather than merely poked) learns it did not happen -
	 * without that answer, ordering a send after this call would be ordering it after nothing. */
	suspend fun drain(client: ConsoleClient): Boolean {
		if (blob.queue.isEmpty()) return true
		// Skip rather than queue: a drain already in flight will pick up whatever this one would
		// have sent, and stacking them behind a slow lane only multiplies the timeouts.
		if (!drainMutex.tryLock()) return false
		try {
			// Each Gateway's lane runs to exhaustion, so a session's whole disposition can flush in
			// one pass; lanes are independent, so a dead Gateway never delays a live one.
			coroutineScope {
				for (gatewayId in blob.queue.map { it.gatewayId }.distinct()) {
					launch { drainLane(client, gatewayId) }
				}
			}
		} finally {
			drainMutex.unlock()
		}
		return true
	}

	private suspend fun drainLane(client: ConsoleClient, gatewayId: String) {
		val tried = mutableSetOf<String>()
		while (true) {
			val action = eligibleBoardActions(blob.queue, STRUGGLING_AFTER).firstOrNull { it.gatewayId == gatewayId }
				?: return
			// One attempt per action per drain: a struggling head is skipped by the NEXT pass, not by
			// this one, so a lane cannot spin over the same failing op inside a single drain.
			if (!tried.add(action.opId)) return
			try {
				client.boardWrite(action.op, action.gatewayId, action.opId)
				mutate { it.copy(queue = retireBoardAction(it.queue, action.opId)) }
			} catch (e: BoardRefused) {
				DebugLog.log("Board", "action ${action.opId} refused: ${e.reason}")
				refusals.add(BoardRefusal(entryIdOf(action.op), e.reason))
				// Abandon dependents too: a move's delete must not fire because its write was refused.
				mutate { it.copy(queue = abandonBoardAction(it.queue, action.opId)) }
			} catch (e: Exception) {
				// A cancellation is not a failed send. Without this the service teardown that cancels
				// the poll scope would charge every in-flight action an attempt it never actually spent.
				e.rethrowIfCancellation()
				// The count is for the owner's marker only; it NEVER retires the action. An edit is
				// discarded on a gateway refusal and on nothing else, so an outage that outlasts any
				// ceiling still ends with the edit applied rather than silently dropped.
				val attempts = action.attempts + 1
				DebugLog.log("Board", "action ${action.opId} retrying (attempt $attempts): ${e.message?.take(80)}")
				mutate { blob ->
					blob.copy(queue = blob.queue.map { if (it.opId == action.opId) it.copy(attempts = attempts) else it })
				}
				return
			}
		}
	}

	/** Refresh one Gateway's half through board_read (the non-route path; the route Gateway's half
	 * arrives on the plane). Any failure leaves the cache as-is - the column just reads stale. */
	suspend fun read(client: ConsoleClient, gatewayId: String) {
		val result = try {
			client.boardRead(gatewayId)
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			DebugLog.log("Board", "board_read $gatewayId failed (column stays stale): ${e.message}")
			return
		}
		applySnapshot(gatewayId, result.entries, version = blob.gateways[gatewayId]?.version, truncated = result.truncated == true)
	}

	/** The value an entry's `sessionId` actually holds, from a chat's `Team.name`. Every board writer
	 * on the Gateway keys by the bare local field, while a Team.name is the fully-qualified address,
	 * so a caller comparing the two raw would match nothing. The one place that conversion happens. */
	fun sessionKeyOf(team: String): String = localFieldOrSelf(team)

	/** How many of a session's live entries are still unfinished - what the forget prompt asks
	 * about, and what decides whether it appears at all. */
	fun undoneCount(gatewayId: String, team: String): Int {
		val key = sessionKeyOf(team)
		return mergedEntries(gatewayId).count {
			it.sessionId == key && it.trashedAt == null && it.state != "done" && it.state != "cancelled"
		}
	}

	/** The forget prompt's decision, sent INLINE and awaited rather than queued: the gateway's
	 * session-end hook unassigns everything it finds, so a disposition arriving afterwards lands on
	 * entries already back in the pile. Returns true only when every op was accepted, which is the
	 * caller's permission to proceed with the forget.
	 *
	 * Deliberately not the pending queue: that drains one op per Gateway per pass, so a session with
	 * two unfinished tasks could never flush its disposition in one go. */
	suspend fun sendDispositionBeforeForget(
		client: BoardWriter,
		gatewayId: String,
		team: String,
		cancelThem: Boolean,
	): Boolean {
		val key = sessionKeyOf(team)
		val undone = mergedEntries(gatewayId).filter {
			it.sessionId == key && it.trashedAt == null && it.state != "done" && it.state != "cancelled"
		}
		for (e in undone) {
			val op = if (cancelThem) ConsoleOp.BoardSetState(e.id, "cancelled") else ConsoleOp.BoardSetSession(e.id, null)
			try {
				client.boardWrite(op, gatewayId)
			} catch (err: BoardRefused) {
				// The gateway will never apply it, so waiting changes nothing; the forget proceeds
				// and the session-end hook decides that entry's fate.
				DebugLog.log("Board", "disposition for ${e.id} refused: ${err.reason}")
			} catch (err: Exception) {
				err.rethrowIfCancellation()
				DebugLog.log("Board", "disposition for ${e.id} did not land: ${err.message?.take(80)}")
				return false
			}
		}
		return true
	}

	/** One session's live line for the session card and thread strip: the task it is on (first
	 * in-progress by rank, else first open), plus its finished-over-total count. Null when the
	 * session has no live entries at all, so the card keeps its ordinary preview ladder. */
	fun liveLine(gatewayId: String, team: String, now: Long = System.currentTimeMillis()): BoardLiveLine? {
		val key = sessionKeyOf(team)
		val mine = mergedEntries(gatewayId, now).filter { it.sessionId == key && it.trashedAt == null }
		if (mine.isEmpty()) return null
		val finished = mine.count { it.state == "done" || it.state == "cancelled" }
		val current = mine.filter { it.state == "in_progress" }.minByOrNull { it.rank }
			?: mine.filter { it.state == "open" }.minByOrNull { it.rank }
			?: mine.minByOrNull { it.rank }
		return BoardLiveLine(current?.title ?: "", current?.state ?: "open", finished, mine.size)
	}

	private fun entryIdOf(op: ConsoleOp): String? = when (op) {
		is ConsoleOp.BoardSetState -> op.id
		is ConsoleOp.BoardSetTitle -> op.id
		is ConsoleOp.BoardSetBody -> op.id
		is ConsoleOp.BoardSetParent -> op.id
		is ConsoleOp.BoardSetTrashed -> op.id
		is ConsoleOp.BoardSetSession -> op.id
		is ConsoleOp.BoardUpsert -> op.entries.firstOrNull()?.id
		is ConsoleOp.BoardRemove -> op.ids.firstOrNull()
		else -> null
	}
}
