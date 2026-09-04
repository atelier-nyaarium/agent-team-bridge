package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ConsoleRenameSessionResult
import com.atelier_nyaarium.switchboard.proto.parseTarget
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.withContext

internal interface RenameHost {
	val state: MutableStateFlow<ChatState>
	fun localDomain(): String
	fun setLabel(team: String, name: String)
	fun persistLabels(labels: Map<String, String>)
	suspend fun renameSession(team: String, name: String): ConsoleRenameSessionResult
	suspend fun refreshPresence()
}

internal class RenameOps(private val host: RenameHost) {
	/**
	 * Set locally first, push, then reconcile to what the gateway applied (it sanitizes and dedups per
	 * spawn, so "foo" may land as "foo-2"). A blank name clears the local label only. On an unreachable
	 * gateway the optimistic label stays. A target outside this Gateway's own Domain gets no optimistic
	 * write, matching the gateway's rename_session guard, or a federated peer's session could flash a
	 * label never applied anywhere; the round trip still runs. A clean rejection (renamed:false)
	 * reverts the optimistic write only while the label still holds exactly what this call wrote, so a
	 * fresher value from withFreshTeams or a newer rename is never clobbered by a late rejection, and
	 * the transient message mirrors that guard. A foreign target is refused server-side as a thrown
	 * error and counts as a rejection, not as the quiet presumed-applied handling above.
	 */
	suspend fun rename(team: String, name: String) {
		val trimmed = name.trim()
		if (trimmed.isEmpty()) {
			host.setLabel(team, "")
			return
		}
		val home = host.state.value.homeGatewayId
		val t = runCatching { parseTarget(team, host.localDomain(), home) }.getOrNull()
		val isLocal = t is Address && t.isLocalTo(host.localDomain(), setOf(home))
		val previous = host.state.value.labels[team]
		if (isLocal) host.setLabel(team, trimmed)
		val reply = withContext(Dispatchers.IO) { host.renameSession(team, trimmed) }
		val applied = reply.takeIf { it.renamed }?.sessionLabel
		if (applied != null && applied != trimmed) {
			// A confirmed server value wins unless the optimistic write no longer holds what this call set.
			val next = host.state.updateAndGet { s ->
				if (!isLocal || s.labels[team] == trimmed) s.copy(labels = s.labels + (team to applied)) else s
			}
			host.persistLabels(next.labels)
		} else if (reply.renamed == false) {
			var reverted = true
			if (isLocal) {
				val before = host.state.value.labels[team]
				val next = host.state.updateAndGet { s ->
					if (s.labels[team] == trimmed) {
						s.copy(labels = if (previous != null) s.labels + (team to previous) else s.labels - team)
					} else s
				}
				host.persistLabels(next.labels)
				reverted = next.labels[team] != before
			}
			if (reverted) host.state.update { it.copy(transientMessages = it.transientMessages + "Could not rename to \"$trimmed\"") }
		}
		host.refreshPresence()
	}
}

internal class ChatRepositoryRenameHost(private val repo: ChatRepository) : RenameHost {
	override val state get() = repo._state
	override fun localDomain() = repo.localDomain()
	override fun setLabel(team: String, name: String) = repo.setLabel(team, name)
	override fun persistLabels(labels: Map<String, String>) = repo.persistence.persistLabels(labels)
	override suspend fun renameSession(team: String, name: String) = repo.client().renameSession(team, name)
	override suspend fun refreshPresence() = repo.presence.refreshAfterAction()
}
