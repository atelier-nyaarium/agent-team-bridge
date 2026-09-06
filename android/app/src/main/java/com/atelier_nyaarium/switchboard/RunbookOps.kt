package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import com.atelier_nyaarium.switchboard.runbooks.RunbookManager
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

internal interface RunbookHost {
	val client: ConsoleClient?
	fun homeGatewayId(): String
	val library: RunbookManager
}

/** What a gateway's copy needs before this library's runbook can be rendered against it. */
internal sealed interface PushDecision {
	/** The gateway already holds this exact runbook. */
	data object Ready : PushDecision
	/** The gateway is missing it, holds it older, or holds something else at the same revision. */
	data object Put : PushDecision
	/** The gateway holds a newer one, which the library takes rather than overwriting. */
	data class Adopt(val theirs: Runbook) : PushDecision
}

/** Revision decides, and equal revisions carrying different words are the gateway's to refuse. */
internal fun pushDecision(mine: Runbook, held: Runbook?): PushDecision = when {
	held == null -> PushDecision.Put
	held.revision > mine.revision -> PushDecision.Adopt(held)
	held.revision < mine.revision -> PushDecision.Put
	held == mine -> PushDecision.Ready
	else -> PushDecision.Put
}

/** A gateway refusing this library's copy, and the revision a save must clear to win. */
internal data class RunbookConflict(val reason: String, val heldRevision: Long)

/** A refusal read as a conflict, so no caller re-reads the shared map for one. */
internal fun conflictOfRefusal(answer: ConsoleRunbookPutResult): RunbookConflict =
	RunbookConflict(answer.reason ?: "This Gateway holds a different copy", answer.revision)

/** A stored put clears the conflict, a refused one raises it, and no answer leaves it standing. */
internal fun conflictsAfterPut(
	held: Map<String, RunbookConflict>,
	runbookId: String,
	answer: ConsoleRunbookPutResult?,
): Map<String, RunbookConflict> = when {
	answer == null -> held
	answer.stored -> held - runbookId
	else -> held + (runbookId to conflictOfRefusal(answer))
}

/** Below the draft's revision the conflict is spent, and rebasing onto it would lose the save. */
internal fun standingConflict(conflict: RunbookConflict?, draftRevision: Long): RunbookConflict? =
	conflict?.takeIf { it.heldRevision >= draftRevision }

/** What became of a save, so the editor closes on one answer and stays open on another. */
internal sealed interface RunbookSaved {
	/** The Gateway took it. */
	data object Stored : RunbookSaved
	/** No Gateway answered, so the copy is the phone's alone. */
	data object Local : RunbookSaved
	/** The Gateway holds something else, and the draft is the owner's to rebase or abandon. */
	data class Refused(val conflict: RunbookConflict) : RunbookSaved
}

/** The phone's library. A gateway holds a copy, which a fire brings up to date first. */
internal class RunbookOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: RunbookHost,
) {
	/** One list-and-push per runbook revision, so typing does not ask the gateway on every keystroke. */
	private val synced = mutableSetOf<Triple<String, String, Long>>()

	private var conflicts = emptyMap<String, RunbookConflict>()

	/** Why a Gateway refused this runbook, for the editor to offer a rebase on. */
	fun conflictOf(runbookId: String): RunbookConflict? = conflicts[runbookId]

	init {
		show(host.library.all())
	}

	/** Adopts anything the gateway holds newer than the library's copy. */
	suspend fun refresh(gatewayId: String = host.homeGatewayId()) {
		val client = host.client ?: return
		if (gatewayId.isBlank()) return
		val held = attempt { client.runbookList(gatewayId) } ?: return
		// What a gateway holds was just read, so nothing older is still worth believing.
		synced.clear()
		show(host.library.merge(held.runbooks))
	}

	/**
	 * Pushed before it answers, so a refusal reaches the editor while the draft is still open. A
	 * Gateway that cannot be reached is not a refusal: the library is the phone's own.
	 */
	suspend fun save(runbook: Runbook, gatewayId: String = host.homeGatewayId()): RunbookSaved {
		synced.removeAll { it.second == runbook.id }
		val client = host.client
		val reachable = client != null && gatewayId.isNotBlank()

		// Refused before the library is touched, so a lost update never lands at all.
		val answer = if (reachable) put(client as ConsoleClient, gatewayId, runbook) else null
		if (answer != null && !answer.stored) return RunbookSaved.Refused(conflictOfRefusal(answer))

		val kept = keep(runbook) ?: return RunbookSaved.Refused(localConflict(runbook))
		if (answer != null) synced += Triple(gatewayId, runbook.id, kept.revision)
		return if (answer != null) RunbookSaved.Stored else RunbookSaved.Local
	}

	/** What the library holds for this runbook afterwards, or null when it did not take the save. */
	private fun keep(runbook: Runbook): Runbook? {
		val library = host.library.merge(listOf(runbook))
		show(library)
		return library.find { it.id == runbook.id }?.takeIf { it == runbook }
	}

	private fun localConflict(runbook: Runbook): RunbookConflict {
		val landed = host.library.find(runbook.id)
		val outranked = landed != null && landed.revision >= runbook.revision
		val reason = if (outranked) "This phone holds a newer copy" else "This phone could not store it"
		return RunbookConflict(reason, landed?.revision ?: 0L)
	}

	suspend fun delete(runbookId: String, gatewayId: String = host.homeGatewayId()) {
		synced.removeAll { it.second == runbookId }
		conflicts = conflicts - runbookId
		show(host.library.remove(runbookId))
		val client = host.client ?: return
		if (gatewayId.isNotBlank()) attempt { client.runbookDelete(gatewayId, runbookId) }
	}

	private fun show(library: List<Runbook>) {
		state.update { it.copy(runbooks = library) }
	}

	suspend fun preview(
		runbookId: String,
		values: Map<String, String>,
		gatewayId: String = host.homeGatewayId(),
	): ConsoleRunbookPreviewResult? {
		val client = host.client ?: return null
		if (!sync(runbookId, gatewayId)) return null
		return attempt { client.runbookPreview(gatewayId, runbookId, values) }
	}

	/** Pinned to the revision a preview answered, so a body edited since is refused rather than sent. */
	suspend fun fire(
		runbookId: String,
		values: Map<String, String>,
		into: RunbookFireTarget,
		previewedRevision: Long?,
		gatewayId: String = host.homeGatewayId(),
	): ConsoleRunbookFireResult? {
		val client = host.client ?: return null
		if (!sync(runbookId, gatewayId)) return null
		return try {
			client.runbookFire(gatewayId, runbookId, values, into, previewedRevision)
		} catch (cancelled: CancellationException) {
			throw cancelled
		} catch (refused: Exception) {
			// A refused target or a rejected op says why; a bare null would throw that away.
			ConsoleRunbookFireResult(fired = false, reason = refused.message ?: "the Gateway refused this fire")
		}
	}

	private suspend fun sync(runbookId: String, gatewayId: String): Boolean {
		val client = host.client ?: return false
		if (gatewayId.isBlank()) return false
		val mine = host.library.find(runbookId) ?: return false
		if (Triple(gatewayId, runbookId, mine.revision) in synced) return true

		val theirs = attempt { client.runbookList(gatewayId) } ?: return false
		// The revision this settles is the one it checked, never whatever the library holds by the end.
		var settledRevision = mine.revision
		val settled = when (val decision = pushDecision(mine, theirs.runbooks.find { it.id == runbookId })) {
			PushDecision.Ready -> true
			is PushDecision.Adopt -> {
				settledRevision = decision.theirs.revision
				show(host.library.merge(listOf(decision.theirs)))
				true
			}
			// A delete that landed while this was in flight must not be undone by its put.
			PushDecision.Put ->
				host.library.find(runbookId) != null && put(client, gatewayId, mine)?.stored == true
		}
		if (settled) synced += Triple(gatewayId, runbookId, settledRevision)
		return settled
	}

	/** The one push. A refusal here is an edit conflict, not an outage, so it is kept to be read. */
	private suspend fun put(client: ConsoleClient, gatewayId: String, mine: Runbook): ConsoleRunbookPutResult? {
		val answer = attempt { client.runbookPut(gatewayId, mine) }
		conflicts = conflictsAfterPut(conflicts, mine.id, answer)
		return answer
	}

	/** A cancelled call must stay cancelled; only a real failure answers null. */
	private suspend fun <T> attempt(call: suspend () -> T): T? = try {
		call()
	} catch (cancelled: CancellationException) {
		throw cancelled
	} catch (_: Exception) {
		null
	}
}
