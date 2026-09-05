package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal interface ConnectHost {
	var homeGatewayId: String
	val firstRooted: Boolean
	val consoleAdmitted: Boolean

	fun saveGatewayId(id: String)
	fun keyringGateways(): List<String>
	fun withoutTombstoned(teams: List<Team>): List<Team>

	suspend fun firstRootIfPending(): Boolean
	suspend fun submitConsoleAdmission()
	fun reportCapabilities()
	fun refreshDisplayName()

	fun attachIngest()
	fun flushIngest()
}

internal class ConnectCoordinator(
	private val identity: PhoneIdentity,
	private val transport: () -> ConsoleReach,
	private val state: MutableStateFlow<ChatState>,
	private val host: ConnectHost,
) {
	suspend fun connect() {
		host.attachIngest()
		DebugLog.log("Connect", "start gateway=${host.homeGatewayId.ifEmpty { "?" }} admitted=${host.consoleAdmitted}")
		// Fence learned facts to the starting provisioning blob.
		val blob = identity.blob() ?: return
		try {
			val reach = runCatchingCancellable { transport().apiReachable() }.getOrElse { e ->
				val (cause, kind) = classifyConnError(e)
				state.update {
					if (kind == ConnKind.TERMINAL) {
						it.copy(status = "error", error = "Cluster: $cause", connected = false, enrollingSince = 0L)
					} else {
						it.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
					}
				}
				return
			}
			DebugLog.log("Connect", "apiReachable ok")
			reach?.domainId?.let { identity.learnDomainId(it, blob) }
			// Root pending invites before submitting admission.
			if (!host.firstRootIfPending()) return
			if (host.firstRooted && !state.value.firstRooted) state.update { it.copy(firstRooted = true) }
			// Admission precedes sealed Gateway registration.
			runCatchingCancellable { host.submitConsoleAdmission() }.onFailure { e ->
				val (cause, kind) = classifyConnError(e)
				state.update {
					it.copy(
						status = if (kind == ConnKind.TERMINAL) "error" else "connecting",
						error = cause,
						connected = false,
						enrollingSince = 0L,
					)
				}
				return
			}
			adoptHomeGateway()
			host.reportCapabilities()
			val teams = state.value.teams
			state.update {
				it.copy(
					teams = host.withoutTombstoned(teams),
					status = "connected",
					error = null,
					connected = true,
					pollFailStreak = 0,
					homeGatewayId = host.homeGatewayId,
					enrollingSince = 0L,
					// Publish sessions and roster as one state update.
					admittedGateways = host.keyringGateways(),
				)
			}
			rosterDomainId(state.value.teams, host.homeGatewayId)?.let { identity.learnDomainId(it, blob) }
			val boot = identity.readyOrNull()
			boot?.let(identity::ensureContentEpochs)
			host.refreshDisplayName()
			DebugLog.log("Connect", "connected gateway=${host.homeGatewayId.ifEmpty { "?" }} domain=${boot?.domainId ?: "none"}")
		} catch (e: Exception) {
			// Preserve coroutine cancellation semantics.
			e.rethrowIfCancellation()
			val (cause, kind) = classifyConnError(e)
			// Clear stale admission so enrollment can retry.
			if (kind == ConnKind.ENROLLING) identity.setConsoleAdmitted(false, blob)
			state.update { s ->
				when (kind) {
					ConnKind.ENROLLING -> {
						val (override, since) = enrollFold(s.enrollingSince)
						s.copy(
							status = if (override != null) "error" else "connecting",
							error = override ?: cause,
							connected = false,
							enrollingSince = since,
						)
					}
					ConnKind.TERMINAL -> s.copy(status = "error", error = cause, connected = false, enrollingSince = 0L)
					ConnKind.TRANSIENT -> s.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
				}
			}
		} finally {
			host.flushIngest()
		}
	}

	private fun adoptHomeGateway() {
		// Keep only a Gateway still admitted by the keyring.
		val admitted = host.keyringGateways()
		val id = state.value.homeGatewayId.takeIf { it in admitted } ?: admitted.firstOrNull().orEmpty()
		if (id != host.homeGatewayId) {
			host.homeGatewayId = id
			host.saveGatewayId(id)
		}
	}
}

internal fun rosterDomainId(teams: List<Team>, homeGatewayId: String): String? =
	// Read the Domain id from the signed home-Gateway roster.
	teams.firstOrNull { (it.gatewayId.ifEmpty { homeGatewayId }) == homeGatewayId && !it.domainId.isNullOrEmpty() }?.domainId

internal class ChatRepositoryConnectHost(private val repo: ChatRepository) : ConnectHost {
	override var homeGatewayId: String
		get() = repo.homeGatewayId
		set(value) { repo.homeGatewayId = value }
	override val firstRooted get() = repo.store.firstRooted
	override val consoleAdmitted get() = repo.store.consoleAdmitted

	override fun saveGatewayId(id: String) = repo.store.saveGatewayId(id)
	override fun keyringGateways() = repo.sessions.keyringGateways()
	override fun withoutTombstoned(teams: List<Team>) = with(repo) { teams.withoutTombstoned() }

	override suspend fun firstRootIfPending() = repo.ownerFacts.firstRootIfPending()
	override suspend fun submitConsoleAdmission() = repo.ownerFacts.submitConsoleAdmission()
	override fun reportCapabilities() {
		repo.pluginReportPending = false
		repo.repoScope.launch { repo.reportCapabilitiesToRouter() }
	}
	override fun refreshDisplayName() = repo.presence.refreshDisplayNameFromTeams()

	override fun attachIngest() {
		runCatching {
			repo.store.load()?.let { DebugLog.attachIngest(ConsoleCredentials.parse(it, repo.store)) { repo.client().transport.proxyBase } }
		}
	}

	override fun flushIngest() = DebugLog.flushToIngest()
}
