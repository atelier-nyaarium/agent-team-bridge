package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.board.BoardLiveLine
import com.atelier_nyaarium.switchboard.board.BoardRefusal
import com.atelier_nyaarium.switchboard.board.CardBranch
import com.atelier_nyaarium.switchboard.board.BoardIntent
import com.atelier_nyaarium.switchboard.proto.BoardAttachment
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardReadResult
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.TaskBoardVersion
import java.io.File
import java.util.UUID
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The repository-side wiring around [ChatRepository.board] (the console's own board half, owned by
 * BoardManager): board_read fan-out, the assign/capture/edit/trash surface, and attachment
 * upload/download tracking.
 * `board` itself (the BoardManager instance) stays on ChatRepository - this class is the repository's
 * OWN state (attachment transfer tracking) plus the ops that reach it. */
internal class BoardOps(private val repo: ChatRepository) {
	private fun enqueue(op: ConsoleOp, gatewayId: String, sources: Map<String, String> = emptyMap()): String {
		val opId = repo.board.enqueue(op, gatewayId, sources = sources)
		// Poll promptly so board edits can ride the next message.
		repo.drain.kickPoll()
		return opId
	}

	/** Re-reads the Router's board and drains what is queued. One board, so there is nothing to gather
	 * per Gateway. Fired on board-tab open, pull-refresh, the board poke, and the poll. */
	fun refreshBoard() {
		repo.repoScope.launch { readRouterBoard() }
	}

	private suspend fun readRouterBoard() {
		val sealing = repo.boardSealing() ?: return
		runCatchingCancellable {
			repo.boardRouter.read(java.util.UUID.randomUUID().toString()) {
				wireJson.decodeFromJsonElement(BoardReadResult.serializer(), it)
			}
			repo.boardRouter.drain(sealing)
		}.onFailure { DebugLog.log("Board", "router read/drain failed: ${it.message?.take(80)}") }
	}

	/** Sessions an entry may be assigned to: a live session (never a spawn-point, which has no record
	 * for the gateway to resolve) on a Gateway this owner's keyring can seal to. The keyring is the
	 * test rather than the Domain fields, which say nothing about whether a seal would succeed. */
	fun boardAssignTargets(): List<Team> {
		val reachable = (repo.sessions.otherKeyringGateways(repo.localGatewayId) + repo.localGatewayId).toSet()
		return repo._state.value.teams.filter {
			it.kind != "console" && it.kind != "devcontainer" && (it.gatewayId.isEmpty() || it.gatewayId in reachable)
		}
	}

	/** Forget a session that still holds unfinished board work. The disposition is a FIELD of the
	 * forget op, so the session's end and its work's end are one gateway-side mutation, and the
	 * gateway disposes of every entry it holds for that session rather than the subset this device
	 * happens to have polled.
	 *
	 * The pending queue is the other writer to those entries, so its actions for them are DROPPED
	 * first: an absolute write draining afterwards would overwrite the choice the owner just made.
	 * `onForgotten` runs only once the forget has actually landed - a session whose forget never
	 * reached its Gateway still exists, so destroying its design cards and notifications would strand
	 * the session with none of its history. */
	fun forgetWithBoardDisposition(team: String, cancelThem: Boolean, onForgotten: () -> Unit) {
		val asked = if (cancelThem) "cancel" else "release"
		repo.board.dropQueuedForSession(boardGatewayOf(team), team)
		repo.sessions.forget(team, asked, onForgotten)
	}

	/** Whether a session's thread belongs to a non-route Gateway (its board half is cadence-fresh
	 * through board_read rather than live on the plane). */
	fun isNonRouteSession(team: String): Boolean {
		val gw = repo._state.value.teams.firstOrNull { it.name == team }?.gatewayId ?: return false
		return gw.isNotEmpty() && gw != repo.localGatewayId
	}

	/** The Gateway a session's board entries home on, read from the ADDRESS itself. A presence-row
	 * lookup missed any team not currently listed and fell back to the route Gateway, landing a
	 * remote session's board reads and queued-write drops on the wrong machine. Takes a chat's
	 * `Team.name` (the qualified address); only an unparseable bare name falls to the route. */
	fun boardGatewayOf(team: String?): String {
		val fromName = team?.let { runCatching { gatewayOf(it) }.getOrNull() }?.ifEmpty { null }
		return fromName ?: repo.localGatewayId
	}

	/** The same answer for an entry's stored `sessionId`, which is the bare local field rather than
	 * the address, so it cannot be matched against `Team.name` directly. NULL rather than the route
	 * fallback when nothing matches: the duplicate-id tie-break asks "is this copy homed where its
	 * session lives", and a total function answers yes for a session that is not there at all.  */
	fun boardGatewayOfKey(sessionKey: String): String? {
		if (sessionKey.isEmpty()) return null
		val gw = repo._state.value.teams.firstOrNull { localFieldOrSelf(it.name) == sessionKey }?.gatewayId
		return gw?.ifEmpty { repo.localGatewayId }
	}

	////////////////////////////////
	//  BoardManager pass-throughs
	//
	//  The only door to BoardManager: a resolver answer, the query it feeds and the revision Compose
	//  invalidates on all come from one object.

	fun boardEntriesFor(team: String?): List<BoardEntry> = repo.board.routerEntries()

	fun boardLiveLineFor(team: String): BoardLiveLine? = repo.board.liveLine(team)

	fun boardUndoneCountFor(team: String): Int = repo.board.undoneCount(team)

	fun boardCardBranchFor(team: String, currentId: String?): CardBranch =
		repo.board.cardBranch(boardGatewayOf(team), team, currentId)

	fun boardSessionKeyOf(team: String): String = repo.board.sessionKeyOf(team)

	fun boardEntriesOn(gatewayId: String): List<BoardEntry> = repo.board.routerEntries()

	/** The whole board. One Router board means one list, grouped by each entry's own session. */
	fun boardEntries(): List<BoardEntry> = repo.board.routerEntries()

	fun boardSourceGatewayIds(): List<String> = repo.board.sourceGatewayIds()

	fun boardLastSyncedAt(gatewayId: String): Long = repo.board.lastSyncedAt(gatewayId)

	fun boardTruncatedGateways(): List<String> = repo.board.truncatedGateways()

	fun boardStrugglingEntries(): Set<String> = repo.board.strugglingEntries()

	fun boardDismissRefusal(refusal: BoardRefusal) = repo.board.dismissRefusal(refusal)

	val boardRefusals get() = repo.board.refusals

	val boardRevision get() = repo.board.revision

	val knownBoardVersion get() = repo.board.knownVersion

	fun applyBoardSnapshot(
		gatewayId: String,
		entries: List<BoardEntry>,
		version: TaskBoardVersion?,
		truncated: Boolean,
	) = repo.board.applySnapshot(gatewayId, entries, version, truncated)

	suspend fun drainBoard() = repo.board.drain(repo.client())

	////////////////////////////////
	//  Ops

	/** Queues one intent and kicks the drain. The row shows immediately through the pending overlay. */
	private fun intend(vararg intents: BoardIntent) {
		repo.board.enqueueWrite(intents.toList())
		repo.repoScope.launch { readRouterBoard() }
	}

	/** Capture a thought at root level, after the last root. */
	fun boardCapture(title: String, body: String?) {
		val last = repo.board.routerEntries()
			.filter { it.parent == null && it.trashedAt == null }
			.maxOfOrNull { it.rank }
		intend(
			BoardIntent.Create(
				id = UUID.randomUUID().toString().replace("-", "").take(32),
				title = title,
				body = body,
				state = "open",
				rank = com.atelier_nyaarium.switchboard.board.BoardRank.between(last, null),
			),
		)
	}

	fun boardSetState(gatewayId: String, id: String, state: String) = intend(BoardIntent.SetState(id, state))

	fun boardSetTitle(gatewayId: String, id: String, title: String) = intend(BoardIntent.SetTitle(id, title))

	fun boardSetBody(gatewayId: String, id: String, body: String?) = intend(BoardIntent.SetBody(id, body))

	/** Re-parent and re-rank in one op, which is what a drag resolves to. */
	fun boardSetParent(gatewayId: String, id: String, parent: String?, rank: String) =
		intend(BoardIntent.SetParent(id, parent, rank))

	fun boardSetTrashed(gatewayId: String, id: String, trashed: Boolean) =
		intend(if (trashed) BoardIntent.Trash(id) else BoardIntent.Restore(id))

	/**
	 * Set an entry's attachments to exactly this list, staging any newly picked file first.
	 *
	 * Absolute like every other board write: adding and removing are the same call, which is why the
	 * caller passes the whole list rather than a delta. A picked file is COPIED into the entry's own
	 * bucket before anything is queued - `admitPicked` stages a bare File with no src, and the copy is
	 * what mints one, which the gallery thumbnail needs anyway.
	 *
	 * Off the caller's thread, always. This arrives from a Compose click and does three full passes
	 * over a file the wire allows to be 500 MB: the content-resolver stage, the hash, and the copy.
	 * On the main thread that is an ANR on any real attachment.
	 */
	fun boardSetAttachments(gatewayId: String, id: String, keep: List<BoardAttachment>, add: List<Uri>) =
		repo.command { boardSetAttachmentsNow(gatewayId, id, keep, add) }

	private fun boardSetAttachmentsNow(gatewayId: String, id: String, keep: List<BoardAttachment>, add: List<Uri>) {
		val bucket = Attachments.boardBucket(id)
		// Staged somewhere OTHER than the destination bucket: keepBuckets pins that bucket for the
		// entry's whole life, so a staged-N left in it would never be swept.
		val (staged, refused) =
			if (add.isEmpty()) emptyList<OutgoingFile>() to null else repo.admitPicked(add, "pick-${UUID.randomUUID()}")
		if (refused != null) {
			repo._state.update { it.copy(error = refused.message()) }
			return
		}
		// Count only. Size is NOT bounded here: a board attachment rides the same chunked plane as any
		// other file and may be as large as the wire allows. What size decides is whether a device
		// fetches it unprompted, which is the gallery's business, not the picker's.
		if (keep.size + staged.size > Protocol.BOARD_ATTACHMENTS_MAX) {
			staged.forEach { it.source.delete() }
			repo._state.update { it.copy(error = "An entry holds at most ${Protocol.BOARD_ATTACHMENTS_MAX} attachments") }
			return
		}
		val sources = mutableMapOf<String, String>()
		val added = staged.mapNotNull { picked ->
			// Landed under its BLOB name, not its display name: a device that downloads this later
			// knows only the blobId, and the owner can pick two files called screenshot.png.
			val blobId = repo.client?.blobIdOf(picked.source) ?: return@mapNotNull null
			val target = Attachments.boardFile(repo.filesDir, id, blobId)
			target.parentFile?.mkdirs()
			picked.source.copyTo(target, overwrite = true)
			picked.source.delete()
			sources[blobId] = target.absolutePath
			BoardAttachment(
				blobId = blobId,
				blobGateway = gatewayId,
				filename = picked.name,
				mime = picked.mime,
				size = picked.size,
			)
		}
		// Every member this device can supply, not just the new picks. The op is absolute, so it
		// re-states the survivors too, and a survivor the Gateway does not hold is unsatisfiable
		// forever otherwise: after a move the destination never ingested it, and a second device
		// editing from a stale list can name one the owner has already removed. The bytes are usually
		// right here, because Question 4 keeps a copy on the device that opened the entry.
		for (a in keep) {
			val local = Attachments.boardFile(repo.filesDir, id, a.blobId)
			if (local.isFile) sources[a.blobId] = local.absolutePath
		}
		// Bytes this entry no longer names, dropped from the device now. The orphan sweep keeps or
		// takes a whole BUCKET, so it can never reclaim one file out of an entry that still holds
		// others - a removed picture would sit there for the entry's whole life.
		// Only files NAMED as a blob: a `.landing` temp belongs to a download still in flight, and
		// deleting it here would tear that transfer's destination out from under it. Those are bounded
		// by the bucket, which goes whole when the entry does.
		val stays = (keep + added).mapTo(mutableSetOf()) { it.blobId }
		Attachments.boardBucketDir(repo.filesDir, id).listFiles()?.forEach {
			if (it.name.startsWith("sha256-") && it.name !in stays) it.delete()
		}

		// `supplied` is a claim about THIS device's disk, nothing more: these are the members whose
		// bytes are here and going up. A member outside it that the Gateway also cannot find exists on
		// no machine, and the Gateway drops it instead of failing the write forever.
		enqueue(
			ConsoleOp.BoardSetAttachments(id, keep + added, supplied = sources.keys.toList()),
			gatewayId,
			sources = sources,
		)
		// Outside the drain, which is single-flight: a multi-minute transfer inside it would stall every
		// board write on every Gateway. repoScope so it survives the Activity going away mid-upload.
		// Cheap for a survivor the Gateway already holds - uploadBlob short-circuits on its stat.
		for ((_, source) in sources) kickBoardUpload(source, gatewayId)
	}

	/**
	 * The local file for one attachment, downloading it if this device does not have it yet.
	 *
	 * Question 4's "on open, and keep": the attaching device already holds the bytes, so its own peek
	 * is instant, and a second device or a reinstall pays once. Null while a fetch is running or after
	 * one gave up, which is what lets a tile show three states rather than a spinner that never ends.
	 */
	fun boardAttachmentFile(entryId: String, a: BoardAttachment): File? {
		val landed = Attachments.boardFile(repo.filesDir, entryId, a.blobId)
		if (landed.isFile) return landed
		// Only small ones come down on their own. A large attachment is legitimate - the plane carries
		// it in chunks like anything else - but opening an entry must not spend hundreds of megabytes
		// of someone's data before they have asked for the file.
		if (a.size <= Protocol.BOARD_AUTO_DOWNLOAD_MAX_BYTES) kickBoardDownload(entryId, a)
		return null
	}

	/** The owner asking for a file the gallery would not fetch on its own. */
	fun boardDownloadAttachment(entryId: String, a: BoardAttachment) {
		boardFetchFailures.remove(a.blobId)
		kickBoardDownload(entryId, a)
	}

	/** Which attachments this device is fetching or has given up on, so a tile can say which. Plain
	 * maps rather than snapshot state: this class holds no Compose types, and the board's own
	 * revision is what the tiles already recompose on. */
	private val boardFetchFailures = java.util.Collections.synchronizedMap(mutableMapOf<String, Int>())
	private val boardDownloadsInFlight = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	// Consecutive PROVEN-absent answers (the Gateway confirmed every holder answered and had
	// nothing), counted apart from ordinary failures: an outage must never trip this. Keyed
	// (entryId, blobId) to match PendingFetch identity - two entries can wait on one picture, and a
	// proof retires only the wait it was counted for. In-memory on purpose: a process death just
	// re-proves it a few polls later, bounded either way.
	private val boardFetchAbsent = java.util.Collections.synchronizedMap(mutableMapOf<Pair<String, String>, Int>())

	fun boardAttachmentState(a: BoardAttachment): String = when {
		a.blobId in boardDownloadsInFlight -> "downloading"
		(boardFetchFailures[a.blobId] ?: 0) >= ChatRepository.BOARD_FETCH_GIVE_UP -> "failed"
		a.size > Protocol.BOARD_AUTO_DOWNLOAD_MAX_BYTES -> "manual"
		else -> "pending"
	}

	private fun kickBoardDownload(entryId: String, a: BoardAttachment) {
		// A queued move is waiting on these, and nothing else can retire it, so giving up would leave
		// the origin's linked delete holding that Gateway's lane closed forever. THIS entry's wait
		// first: two entries can queue the same picture with different holders, and binding the kick
		// to a sibling's wait would count - and retire - the wrong one.
		val fetches = repo.board.pendingFetches()
		val waiting = fetches.firstOrNull { it.blobId == a.blobId && it.entryId == entryId }
			?: fetches.firstOrNull { it.blobId == a.blobId }
		if (waiting == null && (boardFetchFailures[a.blobId] ?: 0) >= ChatRepository.BOARD_FETCH_GIVE_UP) return
		if (!boardDownloadsInFlight.add(a.blobId)) return
		// While a move is queued, the RECORD already names the destination, which by construction does
		// not have the bytes yet. The queued action knows where they actually are.
		val holder = waiting?.holder ?: a.blobGateway
		repo.repoScope.launch {
			try {
				val target = Attachments.boardFile(repo.filesDir, entryId, a.blobId)
				val c = repo.client() ?: return@launch
				val staged = c.downloadBlob(a.blobId, holder)
				target.parentFile?.mkdirs()
				// Through a temp and a rename. A direct overwrite deletes the good copy first and leaves
				// a TRUNCATED file if the process dies mid-copy, which nothing would ever correct: the
				// gallery renders the partial bytes forever, and `supplied` would then assert a blobId
				// this device cannot actually produce, putting the write into an unsatisfiable retry.
				val tmp = File(target.parentFile, "${target.name}.landing")
				try {
					staged.copyTo(tmp, overwrite = true)
					if (!tmp.renameTo(target)) error("could not land ${a.filename}")
				} finally {
					// Whatever went wrong, the partial goes with it. The usual trigger is a full disk, so
					// leaking here would consume more of the exact resource whose exhaustion caused the
					// failure, and nothing else collects it: this entry's bucket is kept for its whole life.
					tmp.delete()
				}
				// The blob store is a transfer buffer; holding the landed copy too would keep every
				// attachment twice on the device with the least room for it.
				c.forgetBlob(a.blobId)
				boardFetchFailures.remove(a.blobId)
				boardFetchAbsent.keys.removeAll { it.second == a.blobId }
				repo.board.revision.longValue++
			} catch (e: BlobAbsent) {
				// Proven, not inferred: the Gateway confirmed every holder answered and had nothing.
				// After a few confirmations the queued move stops waiting on it (retireDeadFetch), the
				// action drains, and the GATEWAY's own drop report is the terminal answer the owner
				// sees - this device never predicts what another machine holds.
				val key = (waiting?.entryId ?: entryId) to a.blobId
				val proven = (boardFetchAbsent[key] ?: 0) + 1
				boardFetchAbsent[key] = proven
				boardFetchFailures[a.blobId] = (boardFetchFailures[a.blobId] ?: 0) + 1
				DebugLog.log("Board", "attachment ${a.blobId.take(16)} proven absent ($proven) for ${key.first}")
				if (proven >= ChatRepository.BOARD_FETCH_DEAD_AFTER && waiting != null) {
					repo.board.retireDeadFetch(waiting.entryId, a.blobId)
					boardFetchAbsent.remove(key)
				}
				repo.board.revision.longValue++
			} catch (e: Exception) {
				e.rethrowIfCancellation()
				// An ordinary failure says nothing about existence, so the absent streak restarts.
				boardFetchAbsent.keys.removeAll { it.second == a.blobId }
				// Bounded like a message's own fetch: a picture whose bytes are gone must stop asking.
				boardFetchFailures[a.blobId] = (boardFetchFailures[a.blobId] ?: 0) + 1
				DebugLog.log("Board", "attachment fetch failed: ${e.message?.take(80)}")
				// So the tile repaints as "could not download" rather than sitting on the last state.
				repo.board.revision.longValue++
			} finally {
				boardDownloadsInFlight.remove(a.blobId)
			}
		}
	}

	/** Every board bucket already on disk, for the one case where the board cannot say which are live. */
	// internal (not private): AttachmentOps.sweepOrphanAttachments (a cold-start pass over ALL
	// attachment kinds, not just the board's) falls back to this when the board itself cannot say
	// which buckets are live.
	internal fun existingBoardBuckets(): Set<String> =
		Attachments.root(repo.filesDir).listFiles()
			?.filter { it.isDirectory && it.name.startsWith("board-") }
			?.mapTo(mutableSetOf()) { it.name }
			?: emptySet()

	/** Whether the board decoded, so a caller can tell an empty board from an unknown one. */
	// internal (not private): AttachmentOps.sweepOrphanAttachments asks before it treats the live
	// board's bucket list as complete. Through this door rather than BoardManager directly, so the
	// board keeps one reacher.
	internal val boardIsKnown: Boolean get() = repo.board.boardIsKnown

	/** The buckets the live board still references. */
	// internal (not private): the same sweep's keep set - see boardIsKnown above.
	internal fun attachmentBuckets(): Set<String> = repo.board.attachmentBuckets()

	/** Restart the transfers whose kick died with the process, or with a failure that only logged.
	 * The queued action survived either way, so without this the drain would check forever and the
	 * picture would never go up. Cheap to repeat: an upload resumes from the Gateway's own cursor. */
	// internal (not private): the poll loop (PollDrain.start) kicks this every pass, and
	// ChatRepository.reconcilePending kicks it once more for whatever died with the process.
	internal fun resumeBoardUploads() {
		for ((_, source, gatewayId) in repo.board.pendingSources()) kickBoardUpload(source, gatewayId)
		// A move's attach waits on bytes this device may never have held. Its own kick dies with the
		// process, and nothing else would ever start it again, so the action would wait forever and its
		// linked origin delete would hold that Gateway's lane closed behind it.
		for ((entryId, blobId, holder) in repo.board.pendingFetches()) {
			if (Attachments.boardFile(repo.filesDir, entryId, blobId).isFile) continue
			// Everything needed is on the action itself. Searching a cached view for the blobId instead
			// answers nothing once the upsert has retired, and can match the wrong entry when the same
			// picture hangs on two of them. Only blobId and gateway are read downstream; the rest of
			// this record is filler, and kickBoardDownload resolves the holder from the queue anyway.
			kickBoardDownload(entryId, BoardAttachment(blobId, holder, blobId, "application/octet-stream", 0))
		}
	}

	/** One transfer per source at a time. Without the guard the poll cadence would start a second
	 * upload of the same file every pass, each racing the last for the same offsets. */
	private val boardUploadsInFlight = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	private fun kickBoardUpload(source: String, gatewayId: String) {
		if (!boardUploadsInFlight.add(source)) return
		repo.repoScope.launch {
			try {
				repo.client?.uploadBlob(File(source), gatewayId)
			} catch (e: Exception) {
				e.rethrowIfCancellation()
				DebugLog.log("Board", "attachment upload failed: ${e.message?.take(80)}")
			} finally {
				boardUploadsInFlight.remove(source)
			}
		}
	}

	/** Assign an entry and its subtree to a session, or null back to the backlog. */
	fun boardAssign(fromGateway: String, id: String, team: String?) {
		// One Router board, so assigning to a session on another Gateway is a field change rather than
		// a move: there is no second copy to upsert and no first copy to delete. The session carries
		// its own gateway, because a bare session id is unique only within one.
		val session = team?.let { name ->
			val row = repo._state.value.teams.firstOrNull { it.name == name }
			BoardSession(
				domainId = row?.domainId ?: repo.localDomain(),
				gatewayId = boardGatewayOf(name),
				sessionId = repo.board.sessionKeyOf(name),
			)
		}
		// The whole subtree moves with its root, which is what the op this replaced did. One write, so
		// the batch is one CAS attempt rather than a partial reassignment if a later one loses.
		intend(*subtreeOf(id).map { BoardIntent.SetSession(it, session) }.toTypedArray())
	}

	/** An entry and everything under it, in the board the owner is looking at. Visited-guarded: a
	 * self-parent from bad data would otherwise walk forever on the main thread. */
	private fun subtreeOf(rootId: String): List<String> {
		val children = repo.board.routerEntries().groupBy { it.parent }
		val out = mutableListOf<String>()
		val seen = mutableSetOf<String>()
		val stack = ArrayDeque(listOf(rootId))
		while (stack.isNotEmpty()) {
			val id = stack.removeLast()
			if (!seen.add(id)) continue
			out.add(id)
			for (kid in children[id] ?: emptyList()) stack.addLast(kid.id)
		}
		return out
	}

}
