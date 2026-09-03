package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.TaskBoardVersion
import kotlinx.serialization.Serializable

/** Retire only on accept or sealed refusal. */
@Serializable
data class PendingBoardAction(
	val opId: String,
	val gatewayId: String,
	val op: ConsoleOp,
	val dependsOn: String? = null,
	// Failed sends; permits lane skipping.
	val attempts: Int = 0,
	// Upload before send; survives restart.
	val sources: Map<String, String> = emptyMap(),
	// Missing fetch source retries.
	val fetchFrom: Map<String, String> = emptyMap(),
)

/** Cache metadata, not entry timestamps. */
@Serializable
data class GatewayBoard(
	val entries: List<BoardEntry> = emptyList(),
	val version: TaskBoardVersion? = null,
	val truncated: Boolean = false,
	val lastSyncedAt: Long = 0,
)

/** Distinguishes refused writes from terminal drops. */
@Serializable
data class BoardRefusal(
	val entryId: String?,
	val reason: String,
	val kind: BoardNoticeKind = BoardNoticeKind.REFUSED,
)

@Serializable
enum class BoardNoticeKind {
	REFUSED,
	DROPPED,
}

@Serializable
data class BoardBlob(
	val gateways: Map<String, GatewayBoard> = emptyMap(),
	/** Router revision used for CAS. */
	val routerRevision: Long = 0,
	/** Sealed Router entries. */
	val stored: List<BoardStoredEntry> = emptyList(),
	/** Cached text survives epoch rotation. */
	val text: Map<String, BoardCachedText> = emptyMap(),
	/** Optimistic writes, oldest first. */
	val pending: List<PendingWrite> = emptyList(),
	val lastRouterSyncAt: Long = 0,
	val queue: List<PendingBoardAction> = emptyList(),
	// Persist notices across background drains.
	val notices: List<BoardRefusal> = emptyList(),
)

/** Per-Gateway oldest eligible actions. */
fun eligibleBoardActions(
	queue: List<PendingBoardAction>,
	strugglingAfter: Int = Int.MAX_VALUE,
): List<PendingBoardAction> {
	val queuedIds = queue.mapTo(HashSet()) { it.opId }
	val chosen = LinkedHashMap<String, PendingBoardAction>()
	val laneClosed = HashSet<String>()
	val skipped = HashMap<String, MutableSet<String>>()
	for (action in queue) {
		val lane = action.gatewayId
		if (lane in laneClosed) continue
		val entries = boardEntryIdsOf(action.op)
		// Pending dependency closes lane.
		if (action.dependsOn != null && action.dependsOn in queuedIds) {
			laneClosed.add(lane)
			continue
		}
		// Never reorder writes to one entry.
		if (skipped[lane]?.let { blocked -> entries.any { it in blocked } } == true) {
			laneClosed.add(lane)
			continue
		}
		if (action.attempts >= strugglingAfter) {
			// Deprioritize, never drop.
			chosen.putIfAbsent(lane, action)
			skipped.getOrPut(lane) { mutableSetOf() }.addAll(entries)
			continue
		}
		chosen[lane] = action
		laneClosed.add(lane)
	}
	return chosen.values.toList()
}

/** Include every touched entry. */
fun boardEntryIdsOf(op: ConsoleOp): Set<String> = when (op) {
	is ConsoleOp.BoardSetState -> setOf(op.id)
	is ConsoleOp.BoardSetTitle -> setOf(op.id)
	is ConsoleOp.BoardSetBody -> setOf(op.id)
	is ConsoleOp.BoardSetParent -> setOf(op.id)
	is ConsoleOp.BoardSetTrashed -> setOf(op.id)
	is ConsoleOp.BoardSetSession -> setOf(op.id)
	is ConsoleOp.BoardSetAttachments -> setOf(op.id)
	is ConsoleOp.BoardUpsert -> op.entries.mapTo(mutableSetOf()) { it.id }
	is ConsoleOp.BoardRemove -> op.ids.toSet()
	else -> emptySet()
}

fun retireBoardAction(queue: List<PendingBoardAction>, opId: String): List<PendingBoardAction> =
	queue.filter { it.opId != opId }

/** Remove unreachable fetches; let Gateway report the drop. */
fun markFetchDead(queue: List<PendingBoardAction>, entryId: String, blobId: String): List<PendingBoardAction> =
	queue.map { action ->
		if (blobId in action.fetchFrom && entryId in boardEntryIdsOf(action.op)) {
			// Preserve attachment claims for Gateway.
			action.copy(fetchFrom = action.fetchFrom - blobId, sources = action.sources - blobId)
		} else {
			action
		}
	}

/** Refused writes abandon dependent deletes. */
fun abandonBoardAction(queue: List<PendingBoardAction>, opId: String): List<PendingBoardAction> {
	val doomed = mutableSetOf(opId)
	var grew = true
	while (grew) {
		grew = queue.any { it.dependsOn in doomed && doomed.add(it.opId) }
	}
	return queue.filter { it.opId !in doomed }
}

/** Reapply pending writes over fresh snapshots. */
fun mergeBoardSnapshot(
	snapshot: List<BoardEntry>,
	queue: List<PendingBoardAction>,
	gatewayId: String,
	now: Long,
): List<BoardEntry> {
	var entries = snapshot
	for (action in queue) {
		if (action.gatewayId == gatewayId) entries = applyBoardOp(entries, action.op, now)
	}
	return entries
}

/** Optimistic mirror; skip missing targets. */
fun applyBoardOp(entries: List<BoardEntry>, op: ConsoleOp, now: Long): List<BoardEntry> {
	fun subtreeIds(rootId: String): Set<String> {
		val children = entries.groupBy { it.parent }
		val out = HashSet<String>()
		val stack = ArrayDeque(listOf(rootId))
		while (stack.isNotEmpty()) {
			val id = stack.removeLast()
			if (!out.add(id)) continue
			for (kid in children[id] ?: emptyList()) stack.addLast(kid.id)
		}
		return out
	}

	return when (op) {
		is ConsoleOp.BoardUpsert -> {
			// New upsert entries clear attachments.
			val byId = op.entries.associateBy { it.id }
			val kept = { e: BoardEntry -> (byId[e.id] ?: e).copy(attachments = e.attachments) }
			entries.map(kept) + op.entries.filter { e -> entries.none { it.id == e.id } }
				.map { it.copy(attachments = null) }
		}
		is ConsoleOp.BoardSetState -> entries.map { if (it.id == op.id) it.copy(state = op.state) else it }
		is ConsoleOp.BoardSetTitle -> entries.map { if (it.id == op.id) it.copy(title = op.title) else it }
		is ConsoleOp.BoardSetBody -> entries.map { if (it.id == op.id) it.copy(body = op.body) else it }
		is ConsoleOp.BoardSetParent ->
			entries.map { if (it.id == op.id) it.copy(parent = op.parent, rank = op.rank) else it }
		is ConsoleOp.BoardSetTrashed -> {
			val members = subtreeIds(op.id)
			val stamp = if (op.trashed) now else null
			entries.map { if (it.id in members) it.copy(trashedAt = stamp) else it }
		}
		is ConsoleOp.BoardSetSession -> {
			val members = subtreeIds(op.id)
			entries.map { if (it.id in members) it.copy(sessionId = op.sessionId) else it }
		}
		is ConsoleOp.BoardSetAttachments ->
			entries.map { if (it.id == op.id) it.copy(attachments = op.attachments) else it }
		is ConsoleOp.BoardRemove -> entries.filter { it.id !in op.ids }
		else -> entries
	}
}
