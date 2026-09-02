package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The second half of a delivered message: pulling down the bytes its files only reference, landing
 * them on the row that named them, and reclaiming the buckets nothing references any more. Owns the
 * single-flight latch, the per-blob failure counts and the given-up set, which is why it is a held
 * delegate rather than extensions the way the voice settings and the drafts are. */
internal class AttachmentOps(private val repo: ChatRepository) {
	/**
	 * Pull a whole blob from the Router's cache, or null so the caller falls back to the origin.
	 *
	 * The answer DECLARES whether it is sealed, because a cache hit is and an origin fallback relayed
	 * through the Router is not, and the bytes do not say which. Written through the same store the
	 * Gateway path uses, so the plaintext digest is verified exactly once and in one place.
	 */
	private suspend fun fromRouterCache(blobId: String): java.io.File? {
		val domain = repo.ownerOps.domainId() ?: return null
		val client = repo.client()
		var offset = client.blobs.stat(blobId).have
		while (true) {
			val answer = repo.routerBlobRange(domain, blobId, offset) ?: return null
			val written = client.blobs.write(blobId, offset, answer.first, answer.second)
			if (answer.second) return if (written.complete) client.blobs.path(blobId) else null
			if (written.have <= offset) return null
			offset = written.have
		}
	}

	// Single-flight latch for fetchPendingAttachments, which the poll loop fires once per pass while
	// a transfer routinely spans several. Not a Mutex: an overlapping pass has nothing to add, since
	// the in-flight run re-derives the same pending set, so it should be dropped rather than queued.
	private val fetchingAttachments = java.util.concurrent.atomic.AtomicBoolean(false)

	// Consecutive failed fetches per blobId. Keyed by blob rather than by row because one unreachable
	// reference can appear on several rows and is one unfetchable thing. In-memory on purpose: a
	// restart is exactly when a previously-hopeless fetch deserves another try.
	private val attachmentFetchFailures = java.util.concurrent.ConcurrentHashMap<String, Int>()

	// Blobs the fetch has GIVEN UP on (bounded tries exhausted), for any UI that must distinguish
	// "arriving" from "will never arrive" - the two were previously the same invisible nothing.
	private val _failedAttachmentFetches = MutableStateFlow<Set<String>>(emptySet())
	val failedAttachmentFetches: StateFlow<Set<String>> = _failedAttachmentFetches

	/** Give a permanently-failed blob another bounded round of tries, deliberately: clears its
	 * failure count (the fetch loop skips anything at the cap, so a retry that does not clear it
	 * would be a button that does nothing) and kicks the fetch. */
	fun retryAttachmentFetch(blobId: String) {
		attachmentFetchFailures.remove(blobId)
		_failedAttachmentFetches.update { it - blobId }
		fetchPendingAttachments()
	}

	/** Cold-start completeness backstop for the per-forget/per-send file deletes (Attachments.
	 * deleteFiles): removes any attachment bucket no surviving row references. The caller MUST
	 * run this to completion before the poll loop starts (see SwitchboardService.onCreate) -
	 * concurrently with a drain, a bucket this sweep captures as unreferenced could be
	 * re-decoded into by a crash re-drain before the delete lands, which Attachments.
	 * sweepOrphanBuckets's own age/mtime guard alone cannot prevent. A scheduled send's own eagerly-
	 * copied bucket is deliberately not a thread row until it fires, so its fileRefs must join the
	 * referenced set too - otherwise a record waiting out a long alarm (or several service restarts)
	 * looks orphaned and gets swept out from under it, and the eventual fire sends text-only. An open
	 * draft's picked files are the same shape of gap: they never become a thread row until Send, so
	 * they must join the referenced set too, or an open draft left untouched past this sweep's age
	 * floor loses its attachments out from under it. */
	suspend fun sweepOrphanAttachments() = withContext(Dispatchers.IO) {
		val referencedSrcs = repo._state.value.threads.values.asSequence()
			.flatMap { it.asSequence() }
			.flatMap { it.files.asSequence() }
			.map { it.src }
			.toList() + repo._state.value.scheduledSends.values.flatMap { it.fileRefs }.map { it.src } +
			repo._state.value.drafts.values.flatMap { it.files }.map { it.src }
		// A video's frame set lives in its own bucket that no src points at, so it has to be named
		// separately or every restart wipes the sets and re-runs the seeks that filled them.
		val frameBuckets = (
			repo._state.value.threads.values.asSequence().flatMap { it.asSequence() }.flatMap { it.files.asSequence() } +
				repo._state.value.drafts.values.asSequence().flatMap { it.files.asSequence() } +
				// Every source referencedSrcs draws from, or a banked send keeps its video and loses the
				// frames for it.
				repo._state.value.scheduledSends.values.asSequence().flatMap { it.fileRefs.asSequence() }
			)
			.filter { it.mime.startsWith("video/") }
			.mapNotNull { VideoThumbs.keyFor(it) }
			.map { VideoThumbs.bucketFor(it) }
			.toSet()
		// Board buckets are named by their entry rather than pointed at by a src, so they need the keep
		// set: a committed attachment has no queued action left to reference it, and Question 4 says the
		// attaching device holds its copy so the peek stays instant.
		//
		// A board that could not be DECODED answers the empty set, which would turn this into "delete
		// what the live board does not reference" over a board that restored empty - the reclaim shape
		// the gateway explicitly refuses, and here it would take every picture on the device in one
		// pass. Unknown is not empty: skip the board's share of the sweep entirely.
		val keep = frameBuckets + repo.boardOps.attachmentBuckets()
		if (repo.boardOps.boardIsKnown) {
			Attachments.sweepOrphanBuckets(repo.filesDir, referencedSrcs, keep)
		} else {
			Attachments.sweepOrphanBuckets(repo.filesDir, referencedSrcs, keep + repo.boardOps.existingBoardBuckets())
		}
		// The blob store's own residue, on the same cold-start pass. Nothing references a staged blob
		// once its bytes reached a bucket, so age is the only signal available and the only one needed:
		// a live transfer is minutes old, and anything swept can be fetched again by name. Runs
		// strictly before the drain starts, same as the bucket sweep, so no in-flight fetch is underfoot.
		val freed = repo.client?.pruneStaleBlobs(ChatRepository.STALE_BLOB_MAX_AGE_MS) ?: 0L
		if (freed > 0) DebugLog.log("Attachments", "pruned $freed bytes of transfer residue")
	}

	/** Best-effort background delete of no-longer-referenced attachment srcs, off the poll
	 * scope's own lifecycle (Dispatchers.IO). A no-op for an empty list. The drain's scope is null
	 * until the loop starts, so this is a silent skip (not a defer) in that window - either way the
	 * next cold-start sweepOrphanAttachments heals any bucket left behind. */
	fun scheduleAttachmentDelete(srcs: List<String>) {
		if (srcs.isEmpty()) return
		repo.drain.scope?.launch(Dispatchers.IO) { Attachments.deleteFiles(repo.filesDir, srcs) }
	}

	/**
	 * Fetch the bytes for every attachment whose message has arrived but whose file has not, and
	 * fill in the src that makes it render.
	 *
	 * A message is prose plus references, so delivery never waits on bytes. This is the second half:
	 * it runs off the drain, one file at a time so a thread of large attachments cannot open a dozen
	 * concurrent transfers, and it is safe to call at any time because the work it looks for is
	 * exactly the work still outstanding. That also makes it the recovery path: a fetch cut off by a
	 * process death is simply still pending on the next pass, and resumes from the bytes already on
	 * disk rather than restarting.
	 *
	 * Single-flight, because the caller fires once per poll pass and a transfer routinely outlives
	 * one. Overlapping passes would re-derive the same pending set, re-download the same blobs, and
	 * race each other inside [Attachments.land].
	 */
	fun fetchPendingAttachments() {
		val client = repo.client ?: return
		// Claim the latch only once there is somewhere to run, and hand it back if the dispatch does
		// not happen. Claiming first would strand it forever on a null or already-cancelled scope,
		// because the release lives in the coroutine body and a body that never runs never releases:
		// attachments would then stop arriving for the life of the process, silently, since this
		// singleton outlives every Activity and service restart.
		val scope = repo.drain.scope ?: return
		if (!fetchingAttachments.compareAndSet(false, true)) return
		val job = scope.launch(Dispatchers.IO) {
			try {
				// Snapshot the work first: the state can change under a long transfer, and each landing
				// re-reads the live row anyway.
				val pending = repo._state.value.threads.flatMap { (team, msgs) ->
					msgs.flatMap { m ->
						m.files.filter { it.blobId != null && it.src == null }.map { Triple(team, m, it) }
					}
				}
				for ((team, message, file) in pending) {
					val blobId = file.blobId ?: continue
					if (attachmentFetchFailures.getOrDefault(blobId, 0) >= ChatRepository.MAX_ATTACHMENT_FETCH_TRIES) continue
					// Router cache first: it holds a copy sealed to this Domain's key, so an attachment
					// stays readable while the machine that produced it is asleep. A miss of any kind
					// falls through to the Gateway that holds the origin.
					val source = runCatchingCancellable {
						fromRouterCache(blobId) ?: client.downloadBlob(blobId, file.blobGateway)
					}
						.onFailure {
							// Count against the blob, not the row: the same reference on several rows is
							// one unfetchable thing, and a bounded count is what stops a blob no Gateway
							// holds from being re-requested on every pass for the life of the install.
							val tries = attachmentFetchFailures.getOrDefault(blobId, 0) + 1
							attachmentFetchFailures[blobId] = tries
							if (tries >= ChatRepository.MAX_ATTACHMENT_FETCH_TRIES) _failedAttachmentFetches.update { s -> s + blobId }
							DebugLog.log("Attachments", "fetch of ${file.name} failed ($tries): $it")
						}
						.getOrNull() ?: continue
					attachmentFetchFailures.remove(blobId)
					_failedAttachmentFetches.update { s -> s - blobId }
					val src =
						Attachments.land(repo.filesDir, Attachments.bucketFor(message.epoch, message.seq), file.name, source)
							?: continue
					landFetchedAttachment(team, message.id, file.name, src)
					// The bytes now live in the attachments bucket, which is the copy the renderer reads
					// and the orphan sweep owns. Keeping the blob as well would hold every attachment
					// twice on the device with the least room for it.
					client.forgetBlob(blobId)
				}
			} finally {
				fetchingAttachments.set(false)
			}
		}
		// A scope cancelled between the claim above and the dispatch creates a job whose body never
		// runs, so its finally never fires. Releasing on completion covers that too, and is a no-op
		// when the body did run and already released.
		job.invokeOnCompletion { fetchingAttachments.set(false) }
	}

	/** Point one already-rendered row's file at its now-present bytes. Matched by name within the
	 * row, the same pairing [Attachments.mergeSentEchoFiles] uses, since both sides derive names
	 * through one safeName/uniqueName chain. */
	private fun landFetchedAttachment(team: String, messageId: Long, name: String, src: String) {
		var changed = false
		val threads = repo._state.updateAndGet { s ->
			// Re-established on EVERY invocation, not just the matching one: updateAndGet re-runs this
			// lambda on a failed CAS, so a value carried over from a losing attempt would describe work
			// the winning attempt did not do (see the same rule spelled out in reconcileSent).
			changed = false
			val thread = s.threads[team] ?: return@updateAndGet s
			val idx = thread.indexOfFirst { it.id == messageId }
			// The row can be gone (a forget, a replace) by the time the bytes land. Its blob stays in
			// the store for the sweep; nothing here has to unwind.
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
		if (changed) repo.persistence.persistThreads(threads)
	}
}
