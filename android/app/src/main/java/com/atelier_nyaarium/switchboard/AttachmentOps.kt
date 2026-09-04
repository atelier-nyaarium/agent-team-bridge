package com.atelier_nyaarium.switchboard

import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun shedDeadAttachmentFailures(
	liveBlobIds: Set<String>,
	failures: MutableMap<String, Int>,
	failed: MutableStateFlow<Set<String>>,
) {
	failures.keys.removeIf { it !in liveBlobIds }
	failed.update { it intersect liveBlobIds }
}

/** Fetches attachment bytes and sweeps residue. */
internal interface AttachmentOpsCollaborators {
	fun clientOrNull(): ConsoleClient?
	suspend fun routerBlobRange(domainId: String, blobId: String, offset: Long, originGateway: String?): Pair<ByteArray, Boolean>?
	fun attachmentBuckets(): Set<String>?
}

internal class AttachmentOps(
	private val state: MutableStateFlow<ChatState>,
	private val persistence: ChatPersistence,
	private val client: ClientPort,
	private val identity: IdentityPort,
	private val filesDir: File,
	private val scope: () -> CoroutineScope?,
	private val collaborators: AttachmentOpsCollaborators,
) {
	/** Range answers declare whether bytes are sealed. */
	private suspend fun fromRouterCache(blobId: String, originGateway: String?): java.io.File? {
		val domain = identity.readyOrNull()?.domainId ?: return null
		val activeClient = client.client()
		var offset = activeClient.blobs.stat(blobId).have
		while (true) {
			val answer = collaborators.routerBlobRange(domain, blobId, offset, originGateway) ?: return null
			val written = activeClient.blobs.write(blobId, offset, answer.first, answer.second)
			if (answer.second) return if (written.complete) activeClient.blobs.path(blobId) else null
			if (written.have <= offset) return null
			offset = written.have
		}
	}

	// Single-flight fetch guard.
	private val fetchingAttachments = java.util.concurrent.atomic.AtomicBoolean(false)

	// Failures counted per blob.
	private val attachmentFetchFailures = java.util.concurrent.ConcurrentHashMap<String, Int>()

	// Blobs at the retry limit.
	private val _failedAttachmentFetches = MutableStateFlow<Set<String>>(emptySet())
	val failedAttachmentFetches: StateFlow<Set<String>> = _failedAttachmentFetches

	/** Clears failures and retries. */
	fun retryAttachmentFetch(blobId: String) {
		attachmentFetchFailures.remove(blobId)
		_failedAttachmentFetches.update { it - blobId }
		fetchPendingAttachments()
	}

	/** Cold-start orphan sweep. Run before polling. */
	suspend fun sweepOrphanAttachments() = withContext(Dispatchers.IO) {
		val referencedSrcs = state.value.threads.values.asSequence()
			.flatMap { it.asSequence() }
			.flatMap { it.files.asSequence() }
			.map { it.src }
			.toList() + state.value.scheduledSends.values.flatMap { it.fileRefs }.map { it.src } +
			state.value.drafts.values.flatMap { it.files }.map { it.src }
		// Video frames have separate buckets.
		val frameBuckets = (
			state.value.threads.values.asSequence().flatMap { it.asSequence() }.flatMap { it.files.asSequence() } +
				state.value.drafts.values.asSequence().flatMap { it.files.asSequence() } +
				// Include banked-send videos.
				state.value.scheduledSends.values.asSequence().flatMap { it.fileRefs.asSequence() }
			)
			.filter { it.mime.startsWith("video/") }
			.mapNotNull { VideoThumbs.keyFor(it) }
			.map { VideoThumbs.bucketFor(it) }
			.toSet()
		// Unknown boards retain all board buckets.
		val keep = collaborators.attachmentBuckets()
		if (keep != null) Attachments.sweepOrphanBuckets(filesDir, referencedSrcs, frameBuckets + keep)
		// Prune staged blobs before polling.
		val freed = collaborators.clientOrNull()?.pruneStaleBlobs(ChatRepository.STALE_BLOB_MAX_AGE_MS) ?: 0L
		if (freed > 0) DebugLog.log("Attachments", "pruned $freed bytes of transfer residue")
	}

	/** Schedules background deletion. */
	fun scheduleAttachmentDelete(srcs: List<String>) {
		if (srcs.isEmpty()) return
		scope()?.launch(Dispatchers.IO) { Attachments.deleteFiles(filesDir, srcs) }
	}

	/** Fetches pending attachments one at a time. */
	fun fetchPendingAttachments() {
		val activeClient = collaborators.clientOrNull() ?: return
		// Release if dispatch cannot run.
		val activeScope = scope() ?: return
		if (!fetchingAttachments.compareAndSet(false, true)) return
		val job = activeScope.launch(Dispatchers.IO) {
			try {
				// Snapshot pending work.
				val pending = state.value.threads.flatMap { (team, msgs) ->
					msgs.flatMap { m ->
						m.files.filter { it.blobId != null && it.src == null }.map { Triple(team, m, it) }
					}
				}
				shedDeadAttachmentFailures(pending.mapNotNull { it.third.blobId }.toSet(), attachmentFetchFailures, _failedAttachmentFetches)
				for ((team, message, file) in pending) {
					val blobId = file.blobId ?: continue
					if (attachmentFetchFailures.getOrDefault(blobId, 0) >= ChatRepository.MAX_ATTACHMENT_FETCH_TRIES) continue
						// Prefer the Router cache.
					val source = runCatchingCancellable {
						fromRouterCache(blobId, file.blobGateway) ?: activeClient.downloadBlob(blobId, file.blobGateway)
					}
						.onFailure {
							// Count failures per blob.
							val tries = attachmentFetchFailures.getOrDefault(blobId, 0) + 1
							attachmentFetchFailures[blobId] = tries
							if (tries >= ChatRepository.MAX_ATTACHMENT_FETCH_TRIES) _failedAttachmentFetches.update { s -> s + blobId }
							DebugLog.log("Attachments", "fetch of ${file.name} failed ($tries): $it")
						}
						.getOrNull() ?: continue
					attachmentFetchFailures.remove(blobId)
					_failedAttachmentFetches.update { s -> s - blobId }
					val src =
						Attachments.land(filesDir, Attachments.bucketFor(message.epoch, message.seq), file.name, source)
							?: continue
					landFetchedAttachment(team, message.id, file.name, src)
					// Attachments bucket owns the landed bytes.
					activeClient.forgetBlob(blobId)
				}
			} finally {
				fetchingAttachments.set(false)
			}
		}
		// Release cancelled dispatches.
		job.invokeOnCompletion { fetchingAttachments.set(false) }
	}

	/** Restores a landed row file. */
	private fun landFetchedAttachment(team: String, messageId: Long, name: String, src: String) {
		var changed = false
		val threads = state.updateAndGet { s ->
			// Re-establish on every CAS attempt.
			changed = false
			val thread = s.threads[team] ?: return@updateAndGet s
			val idx = thread.indexOfFirst { it.id == messageId }
			// Missing rows need no unwind.
			if (idx < 0) {
				changed = false
				return@updateAndGet s
			}
			val row = thread[idx]
			val files = row.files.map { if (it.name == name && it.src == null) it.copy(src = src) else it }
			if (files == row.files) {
				changed = false
				return@updateAndGet s
			}
			changed = true
			val next = thread.toMutableList().also { it[idx] = row.copy(files = files) }
			s.copy(threads = s.threads + (team to next))
		}.threads
		if (changed) persistence.persistThreads(threads)
	}
}
