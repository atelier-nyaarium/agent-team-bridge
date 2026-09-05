package com.atelier_nyaarium.switchboard

internal class TestIdentityPort(private val store: AppStateStore, private val boot: PhoneBootstrap? = null) : IdentityPort {
	private val federationValue = FederationManager(store)
	override fun readyOrNull(): PhoneBootstrap? = boot
	override suspend fun ready(): PhoneBootstrap = boot ?: error("unused")
	override fun ownerOpsOrNull(): OwnerOps? = null
	override fun ensureContentEpochs(boot: PhoneBootstrap) = Unit
	override val federation get() = federationValue
}

internal object FailingClientPort : ClientPort {
	override fun client(): ConsoleClient = error("unused")
	override fun transport(): ConsoleRouterTransport = error("unused")
}

internal object IdlePresencePort : PresencePort {
	override suspend fun refreshAfterAction() = Unit
	override fun refreshAdmittedGateways() = Unit
	override suspend fun reapplyCachedTeams() = Unit
	override suspend fun restoreLastProjection() = Unit
}

/** Counts what a session or drain action asked presence for. */
internal class RecordingPresencePort : PresencePort {
	var refreshes = 0
	var reapplies = 0
	var restores = 0

	override suspend fun refreshAfterAction() { refreshes++ }
	override fun refreshAdmittedGateways() = Unit
	override suspend fun reapplyCachedTeams() { reapplies++ }
	override suspend fun restoreLastProjection() { restores++ }
}
