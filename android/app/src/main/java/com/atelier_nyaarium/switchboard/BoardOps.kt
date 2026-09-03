package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.board.BoardLiveLine
import com.atelier_nyaarium.switchboard.board.BoardRefusal
import com.atelier_nyaarium.switchboard.board.CardBranch
import com.atelier_nyaarium.switchboard.board.BoardIntent
import com.atelier_nyaarium.switchboard.proto.BoardAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardReadResult
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.io.File
import java.util.UUID
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Repository-side board operations. */
internal class BoardOps(private val repo: ChatRepository) {
	/** Reads and drains the Router board. */
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

	/** Assignable live sessions with sealable keys. */
	fun boardAssignTargets(): List<Team> {
		val reachable = repo.sessions.keyringGateways().toSet()
		return repo._state.value.teams.filter {
			it.kind != "console" && it.kind != "devcontainer" && (it.gatewayId.isEmpty() || it.gatewayId in reachable)
		}
	}

	/** Forgets a session and its board disposition. */
	fun forgetWithBoardDisposition(team: String, cancelThem: Boolean, onForgotten: () -> Unit) {
		val asked = if (cancelThem) "cancel" else "release"
		repo.sessions.forget(team, asked, onForgotten)
	}

	/** Resolves the board Gateway from the address. */
	fun boardGatewayOf(team: String?): String {
		val fromName = team?.let { runCatching { gatewayOf(it) }.getOrNull() }?.ifEmpty { null }
		return fromName ?: repo.homeGatewayId
	}

	/** Resolves the board Gateway for a session key. */
	fun boardGatewayOfKey(sessionKey: String): String? {
		if (sessionKey.isEmpty()) return null
		val gw = repo._state.value.teams.firstOrNull { localFieldOrSelf(it.name) == sessionKey }?.gatewayId
		return gw?.ifEmpty { repo.homeGatewayId }
	}

	fun boardEntriesFor(team: String?): List<BoardEntry> = repo.board.routerEntries()

	fun boardLiveLineFor(team: String): BoardLiveLine? = repo.board.liveLine(team)

	fun boardUndoneCountFor(team: String): Int = repo.board.undoneCount(team)

	fun boardCardBranchFor(team: String, currentId: String?): CardBranch =
		repo.board.cardBranch(boardGatewayOf(team), team, currentId)

	fun boardSessionKeyOf(team: String): String = repo.board.sessionKeyOf(team)

	fun boardEntriesOn(gatewayId: String): List<BoardEntry> = repo.board.routerEntries()

	/** The whole Router board. */
	fun boardEntries(): List<BoardEntry> = repo.board.routerEntries()

	fun boardSourceGatewayIds(): List<String> = repo.board.sourceGatewayIds(repo.homeGatewayId)

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
		version: Long?,
		truncated: Boolean,
	) = repo.board.applySnapshot(gatewayId, entries, version, truncated)

	/** Queues an intent. */
	private fun intend(vararg intents: BoardIntent) {
		repo.board.enqueueWrite(intents.toList())
		repo.repoScope.launch { readRouterBoard() }
	}

	/** Captures a root thought. */
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

	/** Reparents and reranks an entry. */
	fun boardSetParent(gatewayId: String, id: String, parent: String?, rank: String) =
		intend(BoardIntent.SetParent(id, parent, rank))

	fun boardSetTrashed(gatewayId: String, id: String, trashed: Boolean) =
		intend(if (trashed) BoardIntent.Trash(id) else BoardIntent.Restore(id))

	/** Sets an entry's complete attachment list. */
	fun boardSetAttachments(gatewayId: String, id: String, keep: List<BoardAttachment>, add: List<Uri>) =
		repo.command { boardSetAttachmentsNow(gatewayId, id, keep, add) }

	private fun boardSetAttachmentsNow(gatewayId: String, id: String, keep: List<BoardAttachment>, add: List<Uri>) {
		val bucket = Attachments.boardBucket(id)
		// Keep staged files outside the destination bucket.
		val (staged, refused) =
			if (add.isEmpty()) emptyList<OutgoingFile>() to null else repo.admitPicked(add, "pick-${UUID.randomUUID()}")
		if (refused != null) {
			repo._state.update { it.copy(error = refused.message()) }
			return
		}
		// Limit count, not size.
		if (keep.size + staged.size > Protocol.BOARD_ATTACHMENTS_MAX) {
			staged.forEach { it.source.delete() }
			repo._state.update { it.copy(error = "An entry holds at most ${Protocol.BOARD_ATTACHMENTS_MAX} attachments") }
			return
		}
		val client = repo.client ?: run {
			staged.forEach { it.source.delete() }
			repo._state.update { it.copy(error = "Connect before adding attachments") }
			return
		}
		val sources = mutableMapOf<String, String>()
		val added = staged.mapNotNull { picked ->
			// Land under the blob name.
			val blobId = client.blobIdOf(picked.source)
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
		// Supply every locally available member.
		for (a in keep) {
			val local = Attachments.boardFile(repo.filesDir, id, a.blobId)
			if (local.isFile) sources[a.blobId] = local.absolutePath
		}
		// Remove only unreferenced landed files.
		val stays = (keep + added).mapTo(mutableSetOf()) { it.blobId }
		Attachments.boardBucketDir(repo.filesDir, id).listFiles()?.forEach {
			if (it.name.startsWith("sha256-") && it.name !in stays) it.delete()
		}

		// Supplied means locally present.
		intend(
			BoardIntent.SetAttachments(
				id,
				(keep + added).map { BoardStateAttachment(it.blobId, it.size, it.mime, it.blobGateway) },
			),
		)
		// Upload outside the single-flight drain.
		for ((_, source) in sources) kickBoardUpload(source, gatewayId)
	}

	/** Returns or starts fetching an attachment. */
	fun boardAttachmentFile(entryId: String, a: BoardAttachment): File? {
		val landed = Attachments.boardFile(repo.filesDir, entryId, a.blobId)
		if (landed.isFile) return landed
		// Auto-download small attachments only.
		if (a.size <= Protocol.BOARD_AUTO_DOWNLOAD_MAX_BYTES) kickBoardDownload(entryId, a)
		return null
	}

	/** Explicitly downloads an attachment. */
	fun boardDownloadAttachment(entryId: String, a: BoardAttachment) {
		boardFetchFailures.remove(a.blobId)
		kickBoardDownload(entryId, a)
	}

	/** Attachment fetch state. */
	private val boardFetchFailures = java.util.Collections.synchronizedMap(mutableMapOf<String, Int>())
	private val boardDownloadsInFlight = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	// Proven absence is separate from ordinary failure.
	private val boardFetchAbsent = java.util.Collections.synchronizedMap(mutableMapOf<Pair<String, String>, Int>())

	fun boardAttachmentState(a: BoardAttachment): String = when {
		a.blobId in boardDownloadsInFlight -> "downloading"
		(boardFetchFailures[a.blobId] ?: 0) >= ChatRepository.BOARD_FETCH_GIVE_UP -> "failed"
		a.size > Protocol.BOARD_AUTO_DOWNLOAD_MAX_BYTES -> "manual"
		else -> "pending"
	}

	private fun kickBoardDownload(entryId: String, a: BoardAttachment) {
		// Prefer this entry's pending wait.
		if ((boardFetchFailures[a.blobId] ?: 0) >= ChatRepository.BOARD_FETCH_GIVE_UP) return
		if (!boardDownloadsInFlight.add(a.blobId)) return
		// The queued action identifies the holder.
		val holder = a.blobGateway
		repo.repoScope.launch {
			try {
				val target = Attachments.boardFile(repo.filesDir, entryId, a.blobId)
				val c = repo.client()
				val staged = c.downloadBlob(a.blobId, holder)
				target.parentFile?.mkdirs()
				// Land atomically through a temporary file.
				val tmp = File(target.parentFile, "${target.name}.landing")
				try {
					staged.copyTo(tmp, overwrite = true)
					if (!tmp.renameTo(target)) error("could not land ${a.filename}")
				} finally {
					// Remove partial output.
					tmp.delete()
				}
				// Discard the transfer buffer.
				c.forgetBlob(a.blobId)
				boardFetchFailures.remove(a.blobId)
				boardFetchAbsent.keys.removeAll { it.second == a.blobId }
				repo.board.revision.longValue++
			} catch (e: BlobAbsent) {
				// Gateway-confirmed absence.
				val key = entryId to a.blobId
				val proven = (boardFetchAbsent[key] ?: 0) + 1
				boardFetchAbsent[key] = proven
				boardFetchFailures[a.blobId] = (boardFetchFailures[a.blobId] ?: 0) + 1
				DebugLog.log("Board", "attachment ${a.blobId.take(16)} proven absent ($proven) for ${key.first}")
				if (proven >= ChatRepository.BOARD_FETCH_DEAD_AFTER) {
					boardFetchAbsent.remove(key)
				}
				repo.board.revision.longValue++
			} catch (e: Exception) {
				e.rethrowIfCancellation()
				// Ordinary failures do not prove absence.
				boardFetchAbsent.keys.removeAll { it.second == a.blobId }
				// Bound repeated failures.
				boardFetchFailures[a.blobId] = (boardFetchFailures[a.blobId] ?: 0) + 1
				DebugLog.log("Board", "attachment fetch failed: ${e.message?.take(80)}")
				// Refresh the tile state.
				repo.board.revision.longValue++
			} finally {
				boardDownloadsInFlight.remove(a.blobId)
			}
		}
	}

	/** All board buckets on disk. */
	internal fun existingBoardBuckets(): Set<String> =
		Attachments.root(repo.filesDir).listFiles()
			?.filter { it.isDirectory && it.name.startsWith("board-") }
			?.mapTo(mutableSetOf()) { it.name }
			?: emptySet()

	/** Whether the board decoded. */
	internal val boardIsKnown: Boolean get() = repo.board.boardIsKnown

	/** Live board attachment buckets. */
	internal fun attachmentBuckets(): Set<String>? = repo.board.attachmentBuckets()

	/** Restarts pending transfers. */
	internal fun resumeBoardUploads() {
	}

	/** One upload per source. */
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
		// Assignment changes fields on one board.
		val session = team?.let { name ->
			val row = repo._state.value.teams.firstOrNull { it.name == name }
			BoardSession(
				domainId = row?.domainId ?: repo.localDomain(),
				gatewayId = boardGatewayOf(name),
				sessionId = repo.board.sessionKeyOf(name),
			)
		}
		// Assign the subtree in one write.
		intend(*subtreeOf(id).map { BoardIntent.SetSession(it, session) }.toTypedArray())
	}

	/** Visited guard prevents cycles. */
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
