package com.atelier_nyaarium.switchboard

import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.crypto.VAULT_TYPED_KIND
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultAnswerResult
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultGrantsResult
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultRevokeResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.VaultPut
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import com.atelier_nyaarium.switchboard.vault.ApprovalGate
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_DENY
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_SESSION
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_WINDOW
import com.atelier_nyaarium.switchboard.vault.VaultDraft
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import com.atelier_nyaarium.switchboard.vault.VaultManager
import com.atelier_nyaarium.switchboard.vault.VaultPendingRequest
import com.atelier_nyaarium.switchboard.vault.VaultRouterWriter
import com.atelier_nyaarium.switchboard.vault.VaultSaveOutcome
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import com.atelier_nyaarium.switchboard.vault.sealDraft
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal interface VaultOpsCollaborators {
	val vault: VaultManager
	val writer: VaultRouterWriter
	fun sealing(): VaultSealing?
	val client: ConsoleClient?
	fun admittedGateways(): List<String>
	val gate: ApprovalGate
}

/** Repository-side vault operations. */
internal class VaultOps(
	private val state: MutableStateFlow<ChatState>,
	private val repoScope: CoroutineScope,
	private val collaborators: VaultOpsCollaborators,
) {
	private val manager get() = collaborators.vault

	// One list in flight, so answers land in order.
	private val refreshMutex = Mutex()

	/** A plane bump the socket pushed is not re-offered, so a failed list retries here. */
	fun refresh() {
		repoScope.launch {
			for (delayMs in REFRESH_RETRY_DELAYS_MS) {
				if (refreshNow()) return@launch
				delay(delayMs)
			}
			refreshNow()
		}
	}

	/** Lists after the held revision, and again from zero when the Router fell behind. */
	suspend fun refreshNow(): Boolean = refreshMutex.withLock {
		manager.sweepRequests()
		val generation = manager.generation
		val since = manager.routerRevision.takeIf { it > 0 }
		val first = list(since) ?: return false
		if (manager.applyList(first, generation = generation)) return true
		if (since == null) return false
		val full = list(null) ?: return false
		manager.applyList(full, generation = generation)
	}

	private suspend fun list(since: Long?) =
		runCatchingCancellable { collaborators.writer.list(since, newOpId()) }
			.onFailure { DebugLog.log("Vault", "list failed: ${it.message?.take(80)}") }
			.getOrNull()

	fun views(): List<VaultEntryView> = collaborators.sealing()?.let { manager.views(it) } ?: emptyList()

	fun view(id: String): VaultEntryView? {
		val sealing = collaborators.sealing() ?: return null
		return manager.stored(id)?.let { manager.view(it, sealing) }
	}

	fun stored(id: String): VaultStoredEntry? = manager.stored(id)

	fun reveal(id: String): String? {
		val sealing = collaborators.sealing() ?: return null
		return manager.stored(id)?.let { manager.openValue(it, sealing) }
	}

	suspend fun save(draft: VaultDraft): VaultSaveOutcome {
		val sealing = collaborators.sealing() ?: return VaultSaveOutcome.Unreachable
		val existing = draft.id?.let { manager.stored(it) }
		val opened = existing?.let { manager.view(it, sealing) }
		val id = draft.id ?: newEntryId()
		val generation = manager.generation
		val sealed = sealDraft(draft, id, existing, opened, sealing) ?: return VaultSaveOutcome.Unreachable
		if (sealed.publicTitle == null && sealed.privateTitle == null) return VaultSaveOutcome.Refused("untitled")
		val put = VaultPut(id = id, expectedRevision = existing?.clear?.revision ?: 0L, sealed = sealed)
		val result = runCatchingCancellable { collaborators.writer.put(put, newOpId()) }
			.onFailure { DebugLog.log("Vault", "put failed: ${it.message?.take(80)}") }
			.getOrNull() ?: return VaultSaveOutcome.Unreachable
		result.entry?.let { manager.applyWrite(it, result.revision, generation = generation) }
		return when (result.outcome) {
			"applied" -> VaultSaveOutcome.Applied(id)
			"conflict" -> VaultSaveOutcome.Conflict
			else -> VaultSaveOutcome.Refused(result.refusal ?: Protocol.Wire.SocketFrame.REFUSED)
		}
	}

	suspend fun delete(id: String): VaultSaveOutcome {
		val existing = manager.stored(id) ?: return VaultSaveOutcome.Refused("entry_missing")
		val generation = manager.generation
		val result = runCatchingCancellable { collaborators.writer.delete(id, existing.clear.revision, newOpId()) }
			.onFailure { DebugLog.log("Vault", "delete failed: ${it.message?.take(80)}") }
			.getOrNull() ?: return VaultSaveOutcome.Unreachable
		result.entry?.let { manager.applyWrite(it, result.revision, generation = generation) }
		return when (result.outcome) {
			"applied" -> VaultSaveOutcome.Applied(id)
			"conflict" -> VaultSaveOutcome.Conflict
			else -> VaultSaveOutcome.Refused(result.refusal ?: Protocol.Wire.SocketFrame.REFUSED)
		}
	}

	/** The plugin's handler; duplicates are dropped by the manager. */
	fun onRequest(team: String, request: VaultRequest) {
		manager.addRequest(team, request)
	}

	fun pendingRequest(requestId: String): VaultPendingRequest? = manager.request(requestId)

	suspend fun ownerPresent(activity: FragmentActivity?): Boolean = collaborators.gate.require(activity)

	/** Answers one request; a typed value seals under the request id, and a deny may carry a steering note. */
	suspend fun answer(
		pending: VaultPendingRequest,
		decision: String,
		typedValue: String? = null,
		note: String? = null,
	): Boolean {
		val client = collaborators.client ?: return false.also { report("Vault: not connected") }
		val value = typedValue?.let { text ->
			collaborators.sealing()?.seal(text, VAULT_TYPED_KIND, pending.requestId)
				?: return false.also { report("Vault: no content key to seal the value") }
		}
		val gatewayId = runCatching { gatewayOf(pending.team) }.getOrNull()
			?: return false.also { report("Vault: the request names no gateway") }
		val result = runCatchingCancellable {
			client.valueResult<ConsoleVaultAnswerResult>(
				client.sendValueOp(gatewayId, ConsoleOp.VaultAnswer(pending.requestId, decision, value, note?.trim()?.ifEmpty { null })),
				"vault_answer",
			)
		}.onFailure { DebugLog.log("Vault", "answer failed: ${it.message?.take(80)}") }.getOrNull()
		when {
			result == null -> report("Vault: the gateway could not be reached")
			result.ok -> {
				if (decision != VAULT_DECISION_DENY) manager.recordAnswer(pending)
				manager.settleRequest(pending.requestId)
			}
			else -> {
				manager.settleRequest(pending.requestId)
				report("Vault: ${result.reason ?: "the answer was refused"}")
			}
		}
		if (result?.ok == true && decision != VAULT_DECISION_DENY) refreshGrantsNow(gatewayId)
		return result?.ok == true
	}

	suspend fun answerById(requestId: String, decision: String): Boolean {
		val pending = manager.request(requestId) ?: return false
		return answer(pending, decision)
	}

	fun refreshGrants() {
		repoScope.launch { refreshGrantsNow() }
	}

	suspend fun refreshGrantsNow(only: String? = null) {
		val client = collaborators.client ?: return
		for (gatewayId in collaborators.admittedGateways().filter { only == null || it == only }) {
			val result = runCatchingCancellable {
				client.valueResult<ConsoleVaultGrantsResult>(client.sendValueOp(gatewayId, ConsoleOp.VaultGrants), "vault_grants")
			}.getOrNull() ?: continue
			manager.setGrants(gatewayId, result.grants)
		}
	}

	suspend fun revoke(gatewayId: String, grantId: String): Boolean {
		val client = collaborators.client ?: return false
		if (gatewayId !in collaborators.admittedGateways()) return false
		val result = runCatchingCancellable {
			client.valueResult<ConsoleVaultRevokeResult>(client.sendValueOp(gatewayId, ConsoleOp.VaultRevoke(grantId)), "vault_revoke")
		}.getOrNull() ?: return false
		refreshGrantsNow(gatewayId)
		return result.revoked
	}

	/** The strongest grant tier a session holds, or null. */
	fun grantTierFor(team: String): String? {
		val gatewayId = runCatching { gatewayOf(team) }.getOrNull() ?: return null
		val local = localFieldOrSelf(team)
		val tiers = manager.grants.value[gatewayId].orEmpty().filter { it.sessionTarget == local }.map { it.tier }
		return when {
			VAULT_DECISION_SESSION in tiers -> VAULT_DECISION_SESSION
			VAULT_DECISION_WINDOW in tiers -> VAULT_DECISION_WINDOW
			else -> null
		}
	}

	private fun report(message: String) {
		state.update { it.copy(error = message) }
	}

	private fun newOpId(): String = UUID.randomUUID().toString()

	private fun newEntryId(): String = UUID.randomUUID().toString().replace("-", "").take(32)

	private companion object {
		val REFRESH_RETRY_DELAYS_MS = listOf(5_000L, 30_000L)
	}
}
