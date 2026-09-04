package com.atelier_nyaarium.switchboard

/** Signed and token-only Router access. */
internal interface ClientPort {
	fun client(): ConsoleClient
	fun transport(): ConsoleRouterTransport
}

internal interface IdentityPort {
	fun readyOrNull(): PhoneBootstrap?
	suspend fun ready(): PhoneBootstrap
	fun ownerOpsOrNull(): OwnerOps?
	fun ensureContentEpochs(boot: PhoneBootstrap)
	val federation: FederationManager
}

internal interface PresencePort {
	suspend fun refreshAfterAction()
	fun refreshAdmittedGateways()
}

internal class ChatRepositoryPorts(private val repo: ChatRepository) : ClientPort, IdentityPort, PresencePort {
	override fun client() = repo.client()
	override fun transport() = repo.transport()
	override fun readyOrNull() = repo.readyOrNull()
	override suspend fun ready() = repo.ready()
	override fun ownerOpsOrNull() = repo.ownerOpsOrNull()
	override fun ensureContentEpochs(boot: PhoneBootstrap) = repo.identity.ensureContentEpochs(boot)
	override val federation get() = repo.federation
	override suspend fun refreshAfterAction() = repo.presence.refreshAfterAction()
	override fun refreshAdmittedGateways() = repo.provisioningHost.refreshAdmittedGateways()
}
