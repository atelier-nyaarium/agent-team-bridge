package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

internal interface RunbookHost {
	val client: ConsoleClient?
	fun homeGatewayId(): String
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

/** The phone's library. A gateway holds a copy, which a fire brings up to date first. */
internal class RunbookOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: RunbookHost,
) {
	/** One list-and-push per runbook revision, so typing does not ask the gateway on every keystroke. */
	private val synced = mutableSetOf<Triple<String, String, Long>>()

	/** Adopts anything the gateway holds newer than the library's copy. */
	suspend fun refresh(gatewayId: String = host.homeGatewayId()) {
		val client = host.client ?: return
		if (gatewayId.isBlank()) return
		val held = attempt { client.runbookList(gatewayId) } ?: return
		// What a gateway holds was just read, so nothing older is still worth believing.
		synced.clear()
		state.update { it.copy(runbooks = merged(it.runbooks, held.runbooks)) }
	}

	fun save(runbook: Runbook) {
		synced.removeAll { it.second == runbook.id }
		state.update { it.copy(runbooks = merged(it.runbooks, listOf(runbook))) }
	}

	suspend fun delete(runbookId: String, gatewayId: String = host.homeGatewayId()) {
		synced.removeAll { it.second == runbookId }
		state.update { it.copy(runbooks = it.runbooks.filterNot { held -> held.id == runbookId }) }
		val client = host.client ?: return
		if (gatewayId.isNotBlank()) attempt { client.runbookDelete(gatewayId, runbookId) }
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
		val mine = state.value.runbooks.find { it.id == runbookId } ?: return false
		if (Triple(gatewayId, runbookId, mine.revision) in synced) return true

		val theirs = attempt { client.runbookList(gatewayId) } ?: return false
		// The revision this settles is the one it checked, never whatever the library holds by the end.
		var settledRevision = mine.revision
		val settled = when (val decision = pushDecision(mine, theirs.runbooks.find { it.id == runbookId })) {
			PushDecision.Ready -> true
			is PushDecision.Adopt -> {
				settledRevision = decision.theirs.revision
				state.update { it.copy(runbooks = merged(it.runbooks, listOf(decision.theirs))) }
				true
			}
			// A delete that landed while this was in flight must not be undone by its put.
			PushDecision.Put ->
				state.value.runbooks.any { it.id == runbookId } &&
					attempt { client.runbookPut(gatewayId, mine).stored } == true
		}
		if (settled) synced += Triple(gatewayId, runbookId, settledRevision)
		return settled
	}

	/** Higher revision wins, and a name orders the tab. */
	private fun merged(library: List<Runbook>, incoming: List<Runbook>): List<Runbook> {
		val byId = library.associateByTo(LinkedHashMap()) { it.id }
		for (candidate in incoming) {
			val held = byId[candidate.id]
			if (held == null || candidate.revision > held.revision) byId[candidate.id] = candidate
		}
		return byId.values.sortedWith(compareBy({ it.name }, { it.id }))
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
