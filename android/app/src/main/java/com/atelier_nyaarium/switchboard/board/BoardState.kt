package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.TaskBoardVersion
import kotlinx.serialization.Serializable

////////////////////////////////
//  Persisted shapes (one prefs key, see AppStateStore.saveTaskBoard)

/** One queued board mutation, retired ONLY on the gateway's accept or sealed refusal - a thrown,
 * cleartext, or transport error always retries. `dependsOn` is the cross-Gateway move's link: the
 * delete half never drains until its write half's opId has retired. */
@Serializable
data class PendingBoardAction(
	val opId: String,
	val gatewayId: String,
	val op: ConsoleOp,
	val dependsOn: String? = null,
	// Failed sends so far. Drives the row's "not synced" marker, and lets the lane step PAST this
	// action so one that cannot currently send does not block every later one.
	val attempts: Int = 0,
	// Local files this action's bytes come from, by blobId. Lives HERE and never on the ConsoleOp,
	// which is generated from the wire schema: a device path names a user and a folder layout, and
	// these cross a Gateway. The drain uploads each before sending, so an attach survives a restart.
	val sources: Map<String, String> = emptyMap(),
	// Members whose bytes must be PULLED before they can be pushed, by the Gateway holding them. A
	// move carries pictures this device may never have opened, so its source file legitimately does
	// not exist yet - which is why a missing file here retries rather than abandoning.
	val fetchFrom: Map<String, String> = emptyMap(),
)

/** One Gateway's cached board half. `lastSyncedAt` is CACHE metadata (deliberately outside the
 * no-timestamps-on-entries rule) - the stale marker reads it to say how stale, not merely that a
 * fetch failed. */
@Serializable
data class GatewayBoard(
	val entries: List<BoardEntry> = emptyList(),
	val version: TaskBoardVersion? = null,
	val truncated: Boolean = false,
	val lastSyncedAt: Long = 0,
)

/**
 * One thing the owner has to be told about a queued write, and WHICH thing it is.
 *
 * A refusal never landed, so the row already snapped back to Gateway truth and the owner can simply
 * redo it. A drop is the opposite on both counts: the write applied, and the pictures are gone from
 * every machine. Telling the owner "a change did not stick" about a drop invites them to redo an edit
 * that already succeeded and to keep waiting for a file nothing will bring back.
 */
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
	val queue: List<PendingBoardAction> = emptyList(),
	// Durable BECAUSE the drain that mints these runs backgrounded, down a cadence ladder that ends in
	// alarm wakeups on a killable process. An in-memory notice about pictures that are gone for good
	// would routinely die before the owner ever opened the app.
	val notices: List<BoardRefusal> = emptyList(),
)

////////////////////////////////
//  Queue reducers

/** The actions eligible to fire now: each Gateway's oldest action whose link (if any) has already
 * retired. Per-Gateway lanes, so one dead machine cannot head-of-line block the live one.
 *
 * A lane may step PAST a head that has failed [strugglingAfter] times, but only onto an action for a
 * DIFFERENT entry: these ops are absolute, so reordering two writes to one entry would apply the
 * older value last. Nothing is ever dropped - the skipped head stays queued and is retried on the
 * next pass - which is what keeps "an edit retires only on a gateway refusal" true while still
 * letting a permanently-unsendable op stop wedging everything behind it. */
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
		// A link that has not retired closes the lane outright: nothing behind a pending write may
		// be reordered ahead of it, since the linked pair is the move's own write-then-delete.
		if (action.dependsOn != null && action.dependsOn in queuedIds) {
			laneClosed.add(lane)
			continue
		}
		// A write to an entry an earlier skipped action also writes cannot jump ahead of it: these
		// ops are absolute, so applying the older value last would undo the newer one.
		if (skipped[lane]?.let { blocked -> entries.any { it in blocked } } == true) {
			laneClosed.add(lane)
			continue
		}
		if (action.attempts >= strugglingAfter) {
			// Deprioritized, NOT dropped: it stays this lane's answer if nothing else qualifies, so a
			// permanently-failing op keeps retrying instead of blocking everything behind it.
			chosen.putIfAbsent(lane, action)
			skipped.getOrPut(lane) { mutableSetOf() }.addAll(entries)
			continue
		}
		chosen[lane] = action
		laneClosed.add(lane)
	}
	return chosen.values.toList()
}

/** Every entry an op writes to. A multi-entry op (a subtree move) touches all of them, and the
 * lane's skip rule needs the full set or it could reorder a write against one of the others. */
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

/** Retire an ACCEPTED action: it applied, so anything linked to it may now proceed. */
fun retireBoardAction(queue: List<PendingBoardAction>, opId: String): List<PendingBoardAction> =
	queue.filter { it.opId != opId }

/**
 * Stop waiting on a member whose bytes PROVABLY exist nowhere: out of `fetchFrom` (nothing resumes
 * the pull) and out of `sources` (readiness stops demanding it). The op's own attachment list is
 * deliberately untouched and the member stays out of `supplied`, so the Gateway DROPS it and
 * reports the drop - the terminal refusal - instead of this device predicting the Gateway's answer.
 * Without this, a move whose picture is gone from every machine retries its pull on every poll
 * forever, and the linked origin delete holds that Gateway's lane closed behind it.
 */
fun markFetchDead(queue: List<PendingBoardAction>, entryId: String, blobId: String): List<PendingBoardAction> =
	queue.map { action ->
		if (blobId in action.fetchFrom && entryId in boardEntryIdsOf(action.op)) {
			action.copy(fetchFrom = action.fetchFrom - blobId, sources = action.sources - blobId)
		} else {
			action
		}
	}

/** Abandon a REFUSED action, taking everything that depended on it. A move's delete half must never
 * become eligible because its write half was refused - that destroys the entry on both Gateways,
 * inverting the whole point of write-then-delete. */
fun abandonBoardAction(queue: List<PendingBoardAction>, opId: String): List<PendingBoardAction> {
	val doomed = mutableSetOf(opId)
	var grew = true
	while (grew) {
		grew = queue.any { it.dependsOn in doomed && doomed.add(it.opId) }
	}
	return queue.filter { it.opId !in doomed }
}

////////////////////////////////
//  The merge base

/**
 * Fold a fresh Gateway snapshot under the pending queue: the snapshot is authoritative EXCEPT for
 * what a still-pending action already changed locally, re-applied on top until that action retires.
 * Without this, every optimistic edit visibly reverts on the next poll and flips back when the
 * queue drains - the same defect `withFreshTeams` exists to prevent for labels.
 */
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

/** Apply one board op optimistically. Mirrors the gateway store's semantics minus the refusals: a
 * target the snapshot no longer holds is skipped (the gateway is about to refuse it anyway). */
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
			// Attachments are dropped here exactly as the gateway's own upsert drops them, because a
			// move ships a subtree VERBATIM. Keeping them locally would show the destination holding
			// pictures it has no bytes for, and the console writes off this view: the next absolute
			// attachment write would re-state a blobId that Gateway can never satisfy, and that op
			// retries forever rather than refusing.
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
