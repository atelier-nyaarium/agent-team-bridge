package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.TrustHandshakeOp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow

internal interface TrustOpsCollaborators {
	suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String): Boolean
	suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String): Boolean
}

internal class TrustOps(
	private val state: MutableStateFlow<ChatState>,
	private val clientPort: ClientPort,
	private val identity: IdentityPort,
	private val presence: PresencePort,
	private val homeGatewayId: () -> String,
	private val collaborators: TrustOpsCollaborators,
) : ClearsOnReprovision {
	// Receiver confirmation needs the pin returned by polling.
	private val receiverPin = mutableMapOf<String, String>()

	override suspend fun clearInMemory() {
		receiverPin.clear()
	}

	/** Fetch the signed-proof-scoped cross-tenant roster. */
	suspend fun fetchRoster(): Result<List<com.atelier_nyaarium.switchboard.proto.RosterMember>> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val result = clientPort.client().roster(identity.federation.signRosterRequest(System.currentTimeMillis()))
				if (!result.ok) error(result.error ?: "roster unavailable")
				result.members ?: emptyList()
			}
		}

	/** Linked peers remain visible when gateways are offline. */
	fun linkedDomains(): List<LinkedDomain> {
		val adminDomain = identity.readyOrNull()?.domainId ?: return emptyList()
		return CrossDomainLink.mergeLinkedDomains(state.value.teams, state.value.linkedPeerOwners, adminDomain)
	}

	fun shareableSessions(): List<Team> {
		val adminDomain = identity.readyOrNull()?.domainId ?: return emptyList()
		val gw = homeGatewayId()
		val s = state.value
		return s.teams
			.filter { (it.domainId.isNullOrEmpty() || it.domainId == adminDomain) && (it.gatewayId.isEmpty() || it.gatewayId == gw) }
			.filter { it.kind == "devcontainer" || it.kind == "loose" }
			.sortedBy { s.label(it.name) }
	}

	suspend fun crossDomainListen(): Result<com.atelier_nyaarium.switchboard.proto.CrossDomainListenResult> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable { clientPort.client().crossDomainListen() }
		}

	/** Open a requester pairing and run the commit-reveal exchange. */
	suspend fun crossDomainRequest(listeningToken: String): Result<CrossDomainPairing> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val pin = newRendezvousPin()
				val boot = identity.readyOrNull() ?: error("Domain not yet confirmed by a local session")
				val adminDomain = boot.domainId
				val result = clientPort.client().crossDomainRequest(
					listeningToken = listeningToken.trim(),
					pin = pin,
					requesterOwnerSignPub = boot.ownerSignPub,
					requesterDomainId = adminDomain,
					requesterGatewayId = homeGatewayId(),
				)
				CrossDomainPairing(pin = pin, result = result)
			}
		}

	suspend fun crossDomainListenState(listeningToken: String): Result<CrossDomainReceiverPairing?> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val state = clientPort.client().crossDomainListenState(listeningToken)
				if (!state.pairingArrived) {
					return@runCatchingCancellable null
				}
				// Pairing readiness requires every signed-link input.
				CrossDomainReceiverPairing(
					sas = state.sas ?: error("pairing arrived without a SAS"),
					friendOwnerSignPub = state.friendOwnerSignPub ?: error("pairing arrived without the friend owner key"),
					friendDomainId = state.friendDomainId ?: error("pairing arrived without the friend Domain id"),
					friendGatewayId = state.friendGatewayId ?: error("pairing arrived without the friend Gateway id"),
					friendGatewaySignPub = state.friendGatewaySignPub ?: error("pairing arrived without the friend sign key"),
					friendGatewayBoxPub = state.friendGatewayBoxPub ?: error("pairing arrived without the friend box key"),
				).also { receiverPin[listeningToken] = state.pin ?: error("pairing arrived without the pin") }
			}
		}

	suspend fun crossDomainConfirmRequester(pairing: CrossDomainPairing, linkNonce: String): Result<ConfirmOutcome> =
		withContext(Dispatchers.IO) {
			val r = pairing.result
			confirmWithMyLink(
				pin = pairing.pin,
				peerOwnerSignPub = r.receiverOwnerSignPub,
				peerDomainId = r.receiverDomainId,
				peerGatewayId = r.receiverGatewayId,
				peerSignPub = r.receiverGatewaySignPub,
				peerBoxPub = r.receiverGatewayBoxPub,
				linkNonce = linkNonce,
			)
		}

	suspend fun crossDomainConfirmReceiver(
		listeningToken: String,
		friend: CrossDomainReceiverPairing,
		linkNonce: String,
	): Result<ConfirmOutcome> = withContext(Dispatchers.IO) {
		val pin = receiverPin[listeningToken] ?: return@withContext Result.failure(
			IllegalStateException("no pairing pin for this listening window; poll the link state first"),
		)
		confirmWithMyLink(
			pin = pin,
			peerOwnerSignPub = friend.friendOwnerSignPub,
			peerDomainId = friend.friendDomainId,
			peerGatewayId = friend.friendGatewayId,
			peerSignPub = friend.friendGatewaySignPub,
			peerBoxPub = friend.friendGatewayBoxPub,
			linkNonce = linkNonce,
		)
	}

	/** Commit local trust before the relay-affinity edge. */
	private suspend fun confirmWithMyLink(
		pin: String,
		peerOwnerSignPub: String,
		peerDomainId: String,
		peerGatewayId: String,
		peerSignPub: String,
		peerBoxPub: String,
		linkNonce: String,
	): Result<ConfirmOutcome> = runCatchingCancellable {
		val mySignedLink = identity.federation.signMyLink(
			peerOwnerSignPub = peerOwnerSignPub,
			peerDomainId = peerDomainId,
			peerGatewayId = peerGatewayId,
			peerSignPub = peerSignPub,
			peerBoxPub = peerBoxPub,
			nowMs = System.currentTimeMillis(),
			nonce = linkNonce,
		)
		// Record the owner-keyed friend edge.
		identity.federation.addTrustedOwner(peerOwnerSignPub)
		clientPort.client().crossDomainConfirm(pin, mySignedLink)
		// Surface relay-edge rejection separately from local linking.
		if (collaborators.submitXdomainLink(identity.ready().domainId, peerDomainId)) {
			ConfirmOutcome.Linked
		} else {
			ConfirmOutcome.RelayEdgeRejected(peerDomainId)
		}
	}

	suspend fun retryXdomainLinkEdge(peerDomainId: String): Result<ConfirmOutcome> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			if (collaborators.submitXdomainLink(identity.ready().domainId, peerDomainId)) {
				ConfirmOutcome.Linked
			} else {
				ConfirmOutcome.RelayEdgeRejected(peerDomainId)
			}
		}
	}

	fun freshLinkNonce(): String = identity.federation.freshLinkNonce()

	suspend fun crossDomainCancel(listeningToken: String?, pin: String?) = withContext(Dispatchers.IO) {
		runCatchingCancellable { clientPort.client().crossDomainCancel(listeningToken, pin) }
	}

	fun isOwnerTrusted(ownerSignPub: String): Boolean = identity.federation.isTrusted(ownerSignPub)

	fun trustedOwners(): Set<String> = identity.federation.trustedOwners()

	suspend fun untrustOwner(peerOwnerSignPub: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			// Remove local trust before remote cleanup.
			identity.federation.removeTrustedOwner(peerOwnerSignPub)
			// Capture peer Domains before local cleanup.
			val peerDomains = runCatchingCancellable {
				clientPort.client().crossDomainListPeers().peers.filter { it.ownerSignPub == peerOwnerSignPub }.map { it.domainId }.toSet()
			}.getOrDefault(emptySet())
			// Gateway cleanup is best-effort after local trust removal.
			runCatchingCancellable { clientPort.client().crossDomainUntrust(peerOwnerSignPub) }
			// Revoke each Router relay edge.
			for (d in peerDomains) {
				runCatchingCancellable { collaborators.revokeXdomainLink(identity.ready().domainId, d) }
			}
			presence.refreshAfterAction()
			Unit
		}
	}

	/** Assign the symmetric SAS role by sorted owner key. */
	private fun trustRole(myOwner: String, peerOwner: String): String =
		if (myOwner < peerOwner) EnrollCeremony.ADMIN else EnrollCeremony.ENROLLEE

	fun mintRendezvousId(): String = identity.federation.freshRendezvousId()

	suspend fun fetchPendingTrust(): Result<List<com.atelier_nyaarium.switchboard.proto.TrustPendingEntry>> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val r = clientPort.client().trustPending(identity.federation.signTrustPendingRequest(System.currentTimeMillis()))
				if (!r.ok) error(r.error ?: "trust pending unavailable")
				r.pending ?: emptyList()
			}
		}

	suspend fun trustExchange(
		rendezvousId: String,
		mySide: String,
		peerOwnerSignPub: String,
	): Result<EnrollExchange> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val myParty = identity.federation.trustParty(identity.ready().domainId)
				runSasExchange(
					myParty = myParty,
					myRole = trustRole(myParty.ownerSignPub, peerOwnerSignPub),
					// The rendezvous ID is the SAS pin.
					pin = rendezvousId,
					salt = identity.federation.freshEnrollSalt(),
					// Recovery re-arms from the roster.
					retryHint = "Try again.",
					transport = object : SasTransport {
						override suspend fun commit(commitment: String): String? {
							val op = if (mySide == TRUST_SIDE_INITIATOR) {
								TrustHandshakeOp.Arm(rendezvousId, myParty.ownerSignPub, peerOwnerSignPub, commitment)
							} else {
								TrustHandshakeOp.Join(rendezvousId, myParty.ownerSignPub, commitment)
							}
							val r = clientPort.client().trustHandshake(op)
							if (!r.ok) error(r.error ?: "trust commit rejected")
							return r.peerCommitment
						}

						override suspend fun reveal(myReveal: com.atelier_nyaarium.switchboard.proto.EnrollReveal) =
							clientPort.client().trustHandshake(TrustHandshakeOp.Reveal(rendezvousId, mySide, myReveal)).let {
								if (!it.ok) error(it.error ?: "trust reveal rejected")
								it.peerReveal
							}
					},
					authenticatePeer = { EnrollCeremony.ownerMismatch(peerOwnerSignPub, it) },
				)
			}
		}

	suspend fun trustCancel(rendezvousId: String) = withContext(Dispatchers.IO) {
		runCatchingCancellable { clientPort.client().trustHandshake(TrustHandshakeOp.Cancel(rendezvousId)) }
	}

	suspend fun crossDomainShares(): Result<Set<Pair<String, String>>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			clientPort.client().crossDomainListShares().shares
				.mapNotNull { e ->
					(e.target as? com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain)?.let {
						e.sessionTarget to it.domainId
					}
				}
				.toSet()
		}
	}

	suspend fun sharedSessionCounts(): Result<Map<String, Int>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val ownerDomains = clientPort.client().crossDomainListPeers().peers
				.filter { it.ownerSignPub.isNotEmpty() }
				.groupBy({ it.ownerSignPub }, { it.domainId })
			val shares = clientPort.client().crossDomainListShares().shares
			val everyoneSessions = shares
				.filter { it.target is com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted }
				.map { it.sessionTarget }
				.toSet()
			val byDomain = shares
				.mapNotNull { e ->
					(e.target as? com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain)?.let {
						it.domainId to e.sessionTarget
					}
				}
				.groupBy({ it.first }, { it.second })
			ownerDomains.mapValues { (_, domains) ->
				(domains.flatMap { byDomain[it].orEmpty() }.toSet() + everyoneSessions).size
			}
		}
	}

	suspend fun sessionsSharedToEveryone(): Result<Set<String>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			clientPort.client().crossDomainListShares().shares
				.filter { it.target is com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted }
				.map { it.sessionTarget }
				.toSet()
		}
	}

	suspend fun setCrossDomainShare(sessionTarget: String, domainId: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain(domainId)
				if (shared) clientPort.client().crossDomainShare(sessionTarget, target) else clientPort.client().crossDomainUnshare(sessionTarget, target)
				Unit
			}
		}

	suspend fun setShareEveryoneTrusted(sessionTarget: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted
				if (shared) clientPort.client().crossDomainShare(sessionTarget, target) else clientPort.client().crossDomainUnshare(sessionTarget, target)
				Unit
			}
		}

	private fun newRendezvousPin(): String {
		val bytes = ByteArray(18)
		java.security.SecureRandom().nextBytes(bytes)
		return android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
	}
}
