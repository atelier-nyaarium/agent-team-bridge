package com.atelier_nyaarium.switchboard

import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.crypto.VAULT_GATEWAYS_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PRIVATE_DESCRIPTION_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PRIVATE_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PUBLIC_DESCRIPTION_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PUBLIC_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_TYPED_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_VALUE_KIND
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultAnswerResult
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultGrantsResult
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultRevokeResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.VaultEntrySealed
import com.atelier_nyaarium.switchboard.proto.VaultPut
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_DENY
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_SESSION
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_WINDOW
import com.atelier_nyaarium.switchboard.vault.VAULT_UNLOCK_EVERY
import com.atelier_nyaarium.switchboard.vault.VAULT_UNLOCK_WINDOW
import com.atelier_nyaarium.switchboard.vault.VAULT_UNLOCK_WINDOW_MS
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import com.atelier_nyaarium.switchboard.vault.VaultManager
import com.atelier_nyaarium.switchboard.vault.VaultPendingRequest
import com.atelier_nyaarium.switchboard.vault.VaultRouterWriter
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.add

internal interface VaultOpsCollaborators {
	val vault: VaultManager
	val writer: VaultRouterWriter
	fun sealing(): VaultSealing?
	val client: ConsoleClient?
	fun admittedGateways(): List<String>
	fun vaultUnlock(): String
}

/** What the editor hands over; a null value keeps the sealed one. */
data class VaultDraft(
	val id: String? = null,
	val publicTitle: String = "",
	val publicDescription: String = "",
	val privateTitle: String = "",
	val privateDescription: String = "",
	val value: String? = null,
	/** Null admits every gateway. */
	val gateways: List<String>? = null,
)

sealed interface VaultSaveOutcome {
	data class Applied(val id: String) : VaultSaveOutcome

	/** The Router's copy moved since the editor opened. */
	data object Conflict : VaultSaveOutcome

	data class Refused(val reason: String) : VaultSaveOutcome

	data object Unreachable : VaultSaveOutcome
}

/** Repository-side vault operations. */
internal class VaultOps(
	private val state: MutableStateFlow<ChatState>,
	private val repoScope: CoroutineScope,
	private val collaborators: VaultOpsCollaborators,
) {
	private val manager get() = collaborators.vault

	@Volatile private var unlockedAt = 0L

	/** A plane bump is acknowledged before the list lands, so a failed list retries here. */
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
	suspend fun refreshNow(): Boolean {
		manager.sweepRequests()
		val first = list(manager.routerRevision.takeIf { it > 0 }) ?: return false
		if (!manager.applyList(first)) {
			val full = list(null) ?: return false
			manager.applyList(full)
		}
		return true
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
		val id = draft.id ?: newEntryId()
		val seal = { text: String, kind: String -> text.trim().takeIf { it.isNotEmpty() }?.let { sealing.seal(it, kind, id) } }
		val value = when {
			draft.value == null -> existing?.sealed?.value
			draft.value.isEmpty() -> null
			else -> sealing.seal(draft.value, VAULT_VALUE_KIND, id) ?: return VaultSaveOutcome.Unreachable
		}
		val gateways = draft.gateways?.let { ids ->
			val text = buildJsonArray { ids.forEach { add(it) } }.toString()
			sealing.seal(text, VAULT_GATEWAYS_KIND, id) ?: return VaultSaveOutcome.Unreachable
		}
		val sealed = VaultEntrySealed(
			publicTitle = seal(draft.publicTitle, VAULT_PUBLIC_TITLE_KIND),
			publicDescription = seal(draft.publicDescription, VAULT_PUBLIC_DESCRIPTION_KIND),
			privateTitle = seal(draft.privateTitle, VAULT_PRIVATE_TITLE_KIND),
			privateDescription = seal(draft.privateDescription, VAULT_PRIVATE_DESCRIPTION_KIND),
			value = value,
			gateways = gateways,
		)
		if (sealed.publicTitle == null && sealed.privateTitle == null) return VaultSaveOutcome.Refused("untitled")
		val put = VaultPut(id = id, expectedRevision = existing?.clear?.revision ?: 0L, sealed = sealed)
		val result = runCatchingCancellable { collaborators.writer.put(put, newOpId()) }
			.onFailure { DebugLog.log("Vault", "put failed: ${it.message?.take(80)}") }
			.getOrNull() ?: return VaultSaveOutcome.Unreachable
		result.entry?.let { manager.applyWrite(it, result.revision) }
		return when (result.outcome) {
			"applied" -> VaultSaveOutcome.Applied(id)
			"conflict" -> VaultSaveOutcome.Conflict
			else -> VaultSaveOutcome.Refused(result.refusal ?: Protocol.Wire.SocketFrame.REFUSED)
		}
	}

	suspend fun delete(id: String): VaultSaveOutcome {
		val existing = manager.stored(id) ?: return VaultSaveOutcome.Refused("entry_missing")
		val result = runCatchingCancellable { collaborators.writer.delete(id, existing.clear.revision, newOpId()) }
			.onFailure { DebugLog.log("Vault", "delete failed: ${it.message?.take(80)}") }
			.getOrNull() ?: return VaultSaveOutcome.Unreachable
		result.entry?.let { manager.applyWrite(it, result.revision) }
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

	/** The gate the security setting asks for before an approval or a reveal. */
	suspend fun ownerPresent(activity: FragmentActivity?, now: Long = System.currentTimeMillis()): Boolean {
		val prompt = when (collaborators.vaultUnlock()) {
			VAULT_UNLOCK_EVERY -> true
			VAULT_UNLOCK_WINDOW -> now - unlockedAt > VAULT_UNLOCK_WINDOW_MS
			else -> false
		}
		if (!requireOwnerPresent(prompt, activity)) return false
		if (prompt) unlockedAt = now
		return true
	}

	/** Answers one request; a typed value seals under the request id. */
	suspend fun answer(pending: VaultPendingRequest, decision: String, typedValue: String? = null): Boolean {
		val client = collaborators.client ?: return false.also { report("Vault: not connected") }
		val value = typedValue?.let { text ->
			collaborators.sealing()?.seal(text, VAULT_TYPED_KIND, pending.requestId)
				?: return false.also { report("Vault: no content key to seal the value") }
		}
		val gatewayId = runCatching { gatewayOf(pending.team) }.getOrNull()
			?: return false.also { report("Vault: the request names no gateway") }
		val result = runCatchingCancellable {
			client.valueResult<ConsoleVaultAnswerResult>(
				client.sendValueOp(gatewayId, ConsoleOp.VaultAnswer(pending.requestId, decision, value)),
				"vault_answer",
			)
		}.onFailure { DebugLog.log("Vault", "answer failed: ${it.message?.take(80)}") }.getOrNull()
		when {
			result == null -> report("Vault: the gateway could not be reached")
			result.ok -> manager.settleRequest(pending.requestId)
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
