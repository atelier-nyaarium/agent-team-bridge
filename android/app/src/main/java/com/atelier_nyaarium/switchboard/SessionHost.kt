package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.ConsoleCreateSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleListDirsResult
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What session control reaches on the repository. */
internal interface SessionHost {
	val state: MutableStateFlow<ChatState>
	val homeGatewayId: String
	val localDomain: String
	val forgottenUntil: MutableMap<String, Long>
	val sandboxDirs: Map<String, List<String>>?
	var terminalRefreshMs: Long
	val spawnRetryWindowMs: Long
	val forgetTombstoneMs: Long

	fun canonicalTarget(team: String): String
	fun forgetReadAnchor(team: String)
	fun rememberProject(target: String)
	fun keyringGateways(): List<String>
	fun launchInBackground(block: suspend () -> Unit)

	suspend fun peekTerminal(team: String, sinceHash: String?): ConsolePeekResult
	suspend fun createSession(
		target: String,
		sessionName: String? = null,
		displayLabel: String? = null,
		workdir: String? = null,
		opId: String,
	): ConsoleCreateSessionResult
	suspend fun tmuxSend(team: String, text: String?, key: String?, submit: Boolean)
	suspend fun listDirs(path: String, hostTarget: String, spawn: String): ConsoleListDirsResult
	suspend fun wake(target: String, opId: String)
	suspend fun closeSession(team: String)
	suspend fun forget(team: String, boardDisposition: String?): String?

	fun persistThreads(threads: Map<String, List<Message>>, anchors: Map<String, ReadAnchor>)
	fun persistLabels(labels: Map<String, String>)
	fun persistDrafts(drafts: Map<String, Draft>)
	fun cancelScheduled(team: String)
	fun cancelGoal(team: String)
	fun dropPlayback(team: String)
	fun scheduleAttachmentDelete(srcs: List<String>)
	fun refreshAfterAction()
	suspend fun reapplyCachedTeams()
}

internal class ChatRepositorySessionHost(private val repo: ChatRepository) : SessionHost {
	override val state get() = repo._state
	override val homeGatewayId get() = repo.homeGatewayId
	override val localDomain get() = repo.localDomain()
	override val forgottenUntil get() = repo.forgottenUntil
	override val sandboxDirs get() = repo.sandboxDirs
	override var terminalRefreshMs: Long
		get() = repo.store.terminalRefreshMs
		set(value) { repo.store.terminalRefreshMs = value }
	override val spawnRetryWindowMs get() = ChatRepository.SPAWN_RETRY_WINDOW_MS
	override val forgetTombstoneMs get() = ChatRepository.FORGET_TOMBSTONE_MS

	override fun canonicalTarget(team: String) = repo.canonicalTarget(team)
	override fun forgetReadAnchor(team: String) {
		repo.presence.lastReportedReadAnchors = repo.presence.lastReportedReadAnchors - team
	}
	override fun rememberProject(target: String) {
		val (gateway, project) = spawnTargetKey(target, repo.homeGatewayId) ?: return
		repo.store.lastProjectByGateway = repo.store.lastProjectByGateway + (gateway to project)
		repo._state.update { it.copy(lastProjectByGateway = repo.store.lastProjectByGateway) }
	}
	override fun keyringGateways() = Keyring.parse(repo.store.loadDomain())?.admittedGatewayIds() ?: emptyList()
	override fun launchInBackground(block: suspend () -> Unit) {
		repo.repoScope.launch(Dispatchers.IO) { block() }
	}

	override suspend fun peekTerminal(team: String, sinceHash: String?) = repo.client().peek(team, sinceHash)
	override suspend fun createSession(
		target: String,
		sessionName: String?,
		displayLabel: String?,
		workdir: String?,
		opId: String,
	) = repo.client().createSession(target, sessionName, displayLabel, workdir, opId)
	override suspend fun tmuxSend(team: String, text: String?, key: String?, submit: Boolean) =
		repo.client().tmuxSend(team, text, key, submit)
	override suspend fun listDirs(path: String, hostTarget: String, spawn: String) =
		repo.client().listDirs(path, hostTarget, spawn)
	override suspend fun wake(target: String, opId: String) = repo.client().wake(target, opId)
	override suspend fun closeSession(team: String) = repo.client().closeSession(team)
	override suspend fun forget(team: String, boardDisposition: String?) = repo.client().forget(team, boardDisposition)

	override fun persistThreads(threads: Map<String, List<Message>>, anchors: Map<String, ReadAnchor>) =
		repo.persistence.persistThreadsAndReadAnchors(threads, anchors)
	override fun persistLabels(labels: Map<String, String>) = repo.persistence.persistLabels(labels)
	override fun persistDrafts(drafts: Map<String, Draft>) = repo.persistence.persistDrafts(drafts)
	override fun cancelScheduled(team: String) = repo.scheduled.cancelScheduledSend(team)
	override fun cancelGoal(team: String) = repo.goals.cancelGoal(team)
	override fun dropPlayback(team: String) {
		repo.repoScope.launch {
			repo.playback.dropQueuedFor(team)
			repo.stts.purge(team)
		}
	}
	override fun scheduleAttachmentDelete(srcs: List<String>) = repo.attachments.scheduleAttachmentDelete(srcs)
	override fun refreshAfterAction() { launchInBackground { repo.presence.refreshAfterAction() } }
	override suspend fun reapplyCachedTeams() { repo.presence.reapplyCachedTeams() }
}
