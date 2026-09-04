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
	fun transport(): ConsoleRouterTransport
	fun client(): ConsoleClient
	fun applyDomainSync(snapshot: DomainSnapshot, version: String)
	fun refreshAdmittedGateways()
	fun localDomain(): String
	fun boardSealing(): BoardSealing?
}

internal class ChatRepositoryProvisioningHost(private val repo: ChatRepository) : RepositoryProvisioningHost {
	@Volatile private var clientBoot: PhoneBootstrap? = null
	@Volatile private var cachedTransport: ConsoleRouterTransport? = null
	@Volatile override var client: ConsoleClient? = null
		set(value) {
			field = value
			if (value == null) {
				clientBoot = null
				cachedTransport = null
			}
		}

	override fun transport(): ConsoleRouterTransport {
		cachedTransport?.let { return it }
		val blob = repo.store.load() ?: error("not provisioned")
		return ConsoleRouterTransport(Provisioning.parse(blob, repo.store), repo.store, { repo.homeGatewayId }, repo.identity::saveBlob).also {
			cachedTransport = it
		}
	}

	override fun client(): ConsoleClient {
		val boot = repo.readyOrNull() ?: error("Domain not yet confirmed")
		if (clientBoot === boot) client?.let { return it }
		return ConsoleClient(
			boot,
			repo.ambient,
			repo.store,
			coordinator = repo.transportCoordinator,
			collaborators = ConsoleClientCollaborators(
				signOwnerOp = { op, opId -> repo.ownerOpsOrNull()?.sign(op, opId) },
				homeGatewayId = { repo.homeGatewayId },
				saveProvisioning = repo.identity::saveBlob,
			),
		).also {
			clientBoot = boot
			client = it
		}
	}

	override fun applyDomainSync(snapshot: DomainSnapshot, version: String) {
		repo.identity.applyDomainSync(snapshot, version)
		client = null
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

	override fun localDomain(): String = repo.readyOrNull()?.domainId.orEmpty()

	override fun boardSealing(): BoardSealing? {
		val boot = repo.readyOrNull() ?: return null
		return BoardSealing(boot, repo.ambient) { epoch ->
			repo.repoScope.launch(Dispatchers.IO) { repo.keyDeliveryOrNull()?.requestMissing(epoch) }
		}
	}
}
