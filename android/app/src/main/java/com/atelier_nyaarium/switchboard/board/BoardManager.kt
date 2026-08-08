package com.atelier_nyaarium.switchboard.board

import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.BoardRefused
import com.atelier_nyaarium.switchboard.ConsoleClient
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.localFieldOrSelf
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.rethrowIfCancellation
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.TaskBoardVersion
import java.io.File
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

/** The one call the drain makes, narrow enough for a test to stand in for the client. */
interface BoardWriter {
	/** Returns the attachment filenames the Gateway could not resolve and therefore did not store. */
	suspend fun boardWrite(
		op: ConsoleOp,
		gatewayId: String,
		opId: String = UUID.randomUUID().toString(),
	): List<String>

	/** Whether the Gateway holding the entry already has these bytes in full. A CHECK, never the
	 * transfer itself: the drain is single-flight, so moving megabytes inside it would stall every
	 * board write on every Gateway for the duration. */
	suspend fun boardBytesReady(blobId: String, gatewayId: String): Boolean = true
}

/** One refused action's residue: the row marker's content, and the draft restore for an edit. */

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

	/** False when a STORED board could not be decoded, as opposed to there being none yet. An empty
	 * board and an unreadable one look identical afterwards, and one of them must not drive a delete.
	 *
	 * Declared ABOVE [blob] on purpose: properties initialize in declaration order, so below it this
	 * field's own initializer would run after [load] and overwrite what load recorded. */
	@Volatile private var loadedCleanly = true
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

	/** Notices awaiting the owner's dismissal, newest last. Snapshot state, so a row appears the moment
	 * one lands rather than at some later unrelated recomposition; mirrored into the durable blob so a
	 * notice minted by a backgrounded drain survives the process being reclaimed. */
	val refusals = mutableStateListOf<BoardRefusal>()

	init {
		// A notice minted while the app was backgrounded is only useful if it is still here when the
		// owner next looks.
		refusals.addAll(blob.notices)
	}

	private fun notice(entry: BoardRefusal) {
		refusals.add(entry)
		mutate { it.copy(notices = it.notices + entry) }
	}

	val knownVersion: TaskBoardVersion?
		get() = blob.gateways[routeGatewayId()]?.version

	private fun routeGatewayId(): String = store.loadGatewayId()

	/**
	 * Whether this device knows enough about the board to let it DELETE attachment bytes.
	 *
	 * A board with no entries is not evidence that no entry has attachments. It is what a failed local
	 * decode looks like, and equally what a Gateway that lost its own board file answers over the
	 * wire - and in that second case the phone's copies are the last ones anywhere, since the
	 * Gateway's bytes survive with nothing left to name them.
	 *
	 * EVERY gateway must have entries, not merely one of them: buckets are keyed by entry and the keep
	 * set is built per gateway, so with two machines a snapshot loss on the second still drops its
	 * buckets out of the keep set while the first keeps this answer true. Two machines is the ordinary
	 * configuration. The cost of being conservative is that a genuinely empty board stops reclaiming
	 * dead buckets until any gateway reports an entry again, which is a leak that self-heals; deleted
	 * bytes do not.
	 */
	val boardIsKnown: Boolean
		get() = loadedCleanly && blob.gateways.values.all { it.entries.isNotEmpty() }

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
		mutate { it.copy(notices = it.notices.filter { n -> n != refusal }) }
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
	fun enqueue(
		op: ConsoleOp,
		gatewayId: String,
		dependsOn: String? = null,
		sources: Map<String, String> = emptyMap(),
		fetchFrom: Map<String, String> = emptyMap(),
	): String {
		val opId = UUID.randomUUID().toString()
		mutate {
			it.copy(
				queue = it.queue +
					PendingBoardAction(opId, gatewayId, op, dependsOn, sources = sources, fetchFrom = fetchFrom),
			)
		}
		return opId
	}

	/** Every attachment bucket the board still needs on this device, for the orphan sweep's keep set.
	 *
	 * Queue sources only cover an action still in flight. Question 4 says the attaching device KEEPS
	 * its copy so the peek stays instant, so the buckets a committed entry names have to be kept
	 * explicitly or the next cold-start sweep takes them and the owner re-downloads their own picture. */
	fun attachmentBuckets(): Set<String> {
		// MERGED, not the raw snapshot: a just-attached picture lives only in the queue until the
		// gateway's next snapshot lands, and a cold-start sweep in that window would delete the bytes
		// the queued action is still trying to upload.
		// Every KNOWN entry, not only those whose list currently names files. The list is gateway
		// metadata and the bytes are the phone's own copy, so tying one to the other means a gateway
		// that loses or strips the field - a rollback, a truncated projection - takes the device's
		// copy with it on the next sweep, which for a picture nothing else still holds is the silent
		// disappearance this whole feature exists to prevent. A bucket whose files were legitimately
		// removed is already emptied at the write, so keeping its name costs nothing.
		val fromEntries = blob.gateways.keys
			.flatMap { mergedEntries(it) }
			.map { Attachments.boardBucket(it.id) }
		// By entry rather than by parsing the stored paths: sources hold absolute paths for the upload,
		// which are not the src shape bucketOf reads.
		val fromQueue = blob.queue.filter { it.sources.isNotEmpty() }
			.mapNotNull { entryIdOf(it.op) }
			.map { Attachments.boardBucket(it) }
		return (fromEntries + fromQueue).toSet()
	}

	/** The cross-Gateway move: the write half upserts the subtree on the target, and the delete
	 * half is LINKED so it cannot drain until the write's acceptance is recorded - per-Gateway
	 * lanes would otherwise let the delete land first and the entry exist nowhere. */
	fun enqueueMove(
		subtree: List<BoardEntry>,
		fromGateway: String,
		toGateway: String,
		sourceFor: (entryId: String, blobId: String) -> String,
	) {
		// Seed the destination as a known Gateway before either half is queued. Membership must not
		// depend on the queue: once the upsert is accepted and retired, a target with no snapshot
		// would drop out of the source list while the origin's delete still subtracts the entry, and
		// it would render nowhere at all.
		mutate { blob ->
			if (blob.gateways.containsKey(toGateway)) blob
			else blob.copy(gateways = blob.gateways + (toGateway to GatewayBoard()))
		}
		var last = enqueue(ConsoleOp.BoardUpsert(subtree), toGateway)
		// The upsert deliberately carries no attachments, so each entry that has any needs its own
		// absolute write on the destination. Chained rather than parallel: the origin delete must not
		// fire until every one of them has landed, or the move destroys the last copy of a picture.
		for (entry in subtree) {
			val members = entry.attachments.orEmpty()
			if (members.isEmpty()) continue
			// Re-stamped to the DESTINATION, which is where these bytes are about to live. Copying the
			// origin's id forward leaves the record naming a machine that no longer has to hold them,
			// and a console routed anywhere else then loses the picture the moment that cache sweeps.
			val landed = members.map { it.copy(blobGateway = toGateway) }
			val held = members.filter { File(sourceFor(entry.id, it.blobId)).isFile }
			last = enqueue(
				ConsoleOp.BoardSetAttachments(entry.id, landed, supplied = held.map { it.blobId }),
				toGateway,
				dependsOn = last,
				sources = members.associate { it.blobId to sourceFor(entry.id, it.blobId) },
				// The members this device does NOT hold. Its bytes are on the ORIGIN, which is what the
				// record names until the destination stores its own. Keeping these out of `supplied` is
				// what leaves the op a terminal answer: a member neither side can produce is DROPPED by
				// the Gateway and reported, rather than retried forever behind a linked delete that
				// closes the origin's lane. Claiming to supply them would disable that and leave
				// forgetting the session as the only escape.
				fetchFrom = members
					.filterNot { File(sourceFor(entry.id, it.blobId)).isFile }
					.associate { it.blobId to it.blobGateway },
			)
		}
		enqueue(ConsoleOp.BoardRemove(subtree.map { it.id }), fromGateway, dependsOn = last)
	}

	/** Drop queued writes for a session's entries, because the owner has just forgotten it.
	 *
	 * The disposition rides the forget op, so it is no longer a writer to race. The queue still is:
	 * a queued edit is absolute, so draining it afterwards would overwrite the choice the gateway
	 * just applied. Superseded by construction - the disposition is the owner's last word on those
	 * entries - so it is dropped rather than ordered.
	 *
	 * Bounded by what this device can see, which is the honest limit: an entry it never polled has no
	 * queued action here either. */
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

	/** Fire every eligible queued action once. Runs on the poll loop's cadence; single-flight so a
	 * slow lane cannot stack drains. Takes the narrow [BoardWriter] rather than the client, so the
	 * drain is unit-testable without a live transport. */
	suspend fun drain(client: BoardWriter) {
		if (blob.queue.isEmpty()) return
		// Skip rather than queue: a drain already in flight will pick up whatever this one would
		// have sent, and stacking them behind a slow lane only multiplies the timeouts.
		if (!drainMutex.tryLock()) return
		try {
			// Each Gateway's lane runs to exhaustion; lanes are independent, so a dead Gateway never
			// delays a live one.
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
			// One attempt per action per drain: a struggling head is skipped by the NEXT pass, not by
			// this one, so a lane cannot spin over the same failing op inside a single drain.
			if (!tried.add(action.opId)) return
			try {
				// Bytes first, and an unfinished upload CHARGES an attempt like any other retry. Not
				// charging looks kinder and is the opposite: a head under the struggling threshold holds
				// `laneClosed`, so an action that never reaches it blocks every other entry's writes on
				// this Gateway forever, with no marker, and nothing can time it out. Charging is what
				// lets `eligibleBoardActions` step past a slow transfer to unrelated work, and "not
				// synced" is honest while a picture is still going up.
				uploadSources(client, action)
				val dropped = client.boardWrite(action.op, action.gatewayId, action.opId)
				mutate { it.copy(queue = retireBoardAction(it.queue, action.opId)) }
				// Shown on the same row the owner already reads for a refused edit. The write applied,
				// but these pictures existed on no machine and are gone, which they have to be told.
				if (dropped.isNotEmpty()) {
					notice(BoardRefusal(entryIdOf(action.op), dropped.joinToString(", "), BoardNoticeKind.DROPPED))
				}
			} catch (e: BoardRefused) {
				DebugLog.log("Board", "action ${action.opId} refused: ${e.reason}")
				notice(BoardRefusal(entryIdOf(action.op), e.reason))
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

	/**
	 * Get this action's bytes onto its Gateway. True when every source is up and the op may send.
	 *
	 * A source file that is GONE can never succeed, so it is abandoned locally rather than retried:
	 * nothing else could ever retire it, and a queued action nothing retires eventually closes the
	 * whole lane. That is a console-minted refusal, using the two calls the wire's own refusal branch
	 * already makes - the console's [BoardRefusal] is a UI row with a free-form reason, not the
	 * gateway's closed union, so this needs no wire shape.
	 */
	private suspend fun uploadSources(client: BoardWriter, action: PendingBoardAction) {
		for ((blobId, source) in action.sources) {
			if (client.boardBytesReady(blobId, action.gatewayId)) continue
			// Not up yet, and the local copy is gone, so no transfer can ever finish it. Nothing else
			// would retire this action, and a queued action nothing retires eventually closes the lane.
			// A member being fetched from elsewhere has no local file YET, which is not the same as
			// gone: a move carries pictures this device may never have opened.
			if (!File(source).exists() && blobId !in action.fetchFrom) {
				DebugLog.log("Board", "action ${action.opId} abandoned: ${source.substringAfterLast('/')} is gone")
				notice(BoardRefusal(entryIdOf(action.op), "that file is no longer on this device"))
				mutate { it.copy(queue = abandonBoardAction(it.queue, action.opId)) }
			}
			// Throwing is how the lane stops here without sending. The attempt the catch charges is
			// meaningless for an action just abandoned (the queue no longer holds it) and is exactly
			// right for one still transferring.
			error("attachment $blobId is not on the Gateway yet")
		}
	}

	/** Local sources for everything still queued, so a cold start can restart the transfers whose
	 * in-memory kick died with the process. Keyed blobId to path, per Gateway. */
	/** The queue in drain order. Its ORDER is behaviour, not internals: a move's origin delete landing
	 * before the destination holds the bytes destroys the last copy. */
	val queuedActions: List<PendingBoardAction>
		get() = blob.queue

	/** Members a queued action must PULL before it can push, as (entry, blobId, holding gateway). The
	 * ENTRY comes from the action rather than being re-found later: once the upsert half retires, no
	 * cached view names that entry, so a search would answer nothing in exactly the window this
	 * exists for. A move's attach cannot retire until these arrive, and its own kick dies with the
	 * process, so the resume pass has to see them or the origin's linked delete blocks that lane. */
	fun pendingFetches(): List<Triple<String, String, String>> =
		blob.queue.flatMap { action ->
			val entryId = entryIdOf(action.op) ?: return@flatMap emptyList()
			action.fetchFrom.map { (blobId, gw) -> Triple(entryId, blobId, gw) }
		}

	fun pendingSources(): List<Triple<String, String, String>> =
		blob.queue.flatMap { action -> action.sources.map { (blobId, src) -> Triple(blobId, src, action.gatewayId) } }

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
		is ConsoleOp.BoardSetAttachments -> op.id
		is ConsoleOp.BoardUpsert -> op.entries.firstOrNull()?.id
		is ConsoleOp.BoardRemove -> op.ids.firstOrNull()
		else -> null
	}
}
