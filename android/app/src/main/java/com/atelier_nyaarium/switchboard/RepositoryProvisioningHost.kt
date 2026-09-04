package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.board.BoardSealing
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal fun selectHomeGateway(current: String, admitted: List<String>): String =
	current.takeIf { it in admitted } ?: admitted.firstOrNull().orEmpty()

internal interface RepositoryProvisioningHost {
	var client: ConsoleClient?
	fun client(): ConsoleClient
	fun applyDomainSync(snapshot: DomainSnapshot, version: String)
	fun refreshAdmittedGateways()
	fun localDomain(): String
	fun boardSealing(): BoardSealing?
}

internal class ChatRepositoryProvisioningHost(private val repo: ChatRepository) : RepositoryProvisioningHost {
	@Volatile override var client: ConsoleClient? = null

	override fun client(): ConsoleClient {
		client?.let { return it }
		val blob = repo.store.load() ?: error("not provisioned")
		return ConsoleClient(
			Provisioning.parse(blob, repo.store),
			repo.store,
			coordinator = repo.transportCoordinator,
			signOwnerOp = { op, opId -> repo.ownerOps.sign(op, opId) },
			domainId = { repo.confirmedDomainId() },
			ownerSignPub = { repo.federation.ownerSignPub() },
			homeGatewayId = { repo.homeGatewayId },
			contentKeyring = { repo.federation.contentKeyring() },
		).also { client = it }
	}

	override fun applyDomainSync(snapshot: DomainSnapshot, version: String) {
		repo.federation.applyDomainSync(snapshot, version)
		refreshAdmittedGateways()
	}

	override fun refreshAdmittedGateways() {
		val ids = repo.sessions.keyringGateways()
		val nextHome = selectHomeGateway(repo.homeGatewayId, ids)
		if (nextHome != repo.homeGatewayId) {
			repo.homeGatewayId = nextHome
			repo.store.saveGatewayId(nextHome)
		}
		if (ids != repo._state.value.admittedGateways || nextHome != repo._state.value.homeGatewayId)
			repo._state.update { it.copy(admittedGateways = ids, homeGatewayId = nextHome) }
		// Remove revoked Gateway columns.
		repo.boardOps.boardRetainGateways(ids)
	}

	override fun localDomain(): String = repo.confirmedDomainId() ?: ""

	override fun boardSealing(): BoardSealing? {
		val domain = repo.ownerOps.domainId() ?: return null
		return BoardSealing(repo.federation.contentKeyring(), domain, repo.federation.ownerSignPub()) { epoch ->
			repo.repoScope.launch(Dispatchers.IO) { repo.keyDelivery.requestMissing(epoch) }
		}
	}
}
