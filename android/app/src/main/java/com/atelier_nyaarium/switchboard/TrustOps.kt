package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SasCrypto
import com.atelier_nyaarium.switchboard.proto.TrustHandshakeOp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The cross-Domain trust surface: the roster, the link/share/unlink wizard's REQUESTER and
 * RECEIVER legs, the owner-keyed friend graph, and the FLOW-2 roster-initiated trust rendezvous.
 * Split out of ChatRepository; see its own doc for the collaborator split. */
internal class TrustOps(private val repo: ChatRepository) {
	// RECEIVER link state: the requester-minted pin learned from a listen-state poll, keyed by the
	// receiver's listening token. The receiver needs it to confirm its pairing (the gateway resolves
	// the window by the pin), but the wizard only holds the token, so the poll stashes it here.
	private val receiverPin = mutableMapOf<String, String>()

	/** Fetch the cross-tenant roster (the Users surface): every member on this evie, by name +
	 * presence. evie-direct + signed-proof scoped; a non-member or auth failure surfaces as a
	 * failure with evie's opaque reason. The rendering surface consumes the rows. */
	suspend fun fetchRoster(): Result<List<com.atelier_nyaarium.switchboard.proto.RosterMember>> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val result = repo.client().roster(repo.federation.signRosterRequest(System.currentTimeMillis()))
				if (!result.ok) error(result.error ?: "roster unavailable")
				result.members ?: emptyList()
			}
		}

	////////////////////////////////
	//  Cross-Domain trust (the link/share/unlink surface the Federation UI drives)

	/** The linked friend Domains. The trust roster comes from the route Gateway's cross-Domain peer
	 * set (pushed on the poll response's linkedPeers plane; see applyLinkedPeers): a peer is listed
	 * the moment it is linked, regardless of whether its gateway is online or has shared anything
	 * back. That set is unioned with the discovery-derived Domains so a just-linked peer is
	 * immediately visible (and its detail reachable to start sharing) before any of its sessions
	 * surface in discovery. Discovery still supplies the session count + presence; a peer present
	 * only in the peer set shows zero sessions / offline. */
	fun linkedDomains(): List<LinkedDomain> {
		val adminDomain = repo.confirmedDomainId() ?: return emptyList()
		return CrossDomainLink.mergeLinkedDomains(repo._state.value.teams, repo._state.value.linkedPeerOwners, adminDomain)
	}

	/** My LOCAL devcontainer/loose sessions, the only kinds shareable to a friend Domain (never the
	 * host-agent, the cli host, or a console). Drives the per-session share checkmarks. */
	fun shareableSessions(): List<Team> {
		val adminDomain = repo.confirmedDomainId() ?: return emptyList()
		val gw = repo.localGatewayId
		val s = repo._state.value
		return s.teams
			.filter { (it.domainId.isNullOrEmpty() || it.domainId == adminDomain) && (it.gatewayId.isEmpty() || it.gatewayId == gw) }
			.filter { it.kind == "devcontainer" || it.kind == "loose" }
			.sortedBy { s.label(it.name) }
	}

	/** RECEIVER: open a listening window, returning the token to read to the friend + this
	 * Gateway's keys + the expiry. */
	suspend fun crossDomainListen(): Result<com.atelier_nyaarium.switchboard.proto.CrossDomainListenResult> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable { repo.client().crossDomainListen() }
		}

	/** REQUESTER: mint a one-time rendezvous pin, pair against the friend's token, and run the
	 * commit-reveal exchange. Returns the SAS + both sides' keys (and the pin, so confirm can pass
	 * it back). The Gateway uses this owner's admitted owner key, not the advisory value sent. */
	suspend fun crossDomainRequest(listeningToken: String): Result<CrossDomainPairing> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val pin = newRendezvousPin()
				val adminDomain = repo.confirmedDomainId() ?: error("Domain not yet confirmed by a local session")
				val result = repo.client().crossDomainRequest(
					listeningToken = listeningToken.trim(),
					pin = pin,
					requesterOwnerSignPub = repo.federation.ownerSignPub(),
					requesterDomainId = adminDomain,
					requesterGatewayId = repo.localGatewayId,
				)
				CrossDomainPairing(pin = pin, result = result)
			}
		}

	/** RECEIVER: poll the listening window's pairing state. Returns null until a requester pairs;
	 * once the exchange lands, returns the SAS + the friend (requester) keys the receiver
	 * owner-signs its own link over, plus the pin to pass to confirm. The receiver polls this on a
	 * short interval while on the link screen (its only path out of "awaiting request"). */
	suspend fun crossDomainListenState(listeningToken: String): Result<CrossDomainReceiverPairing?> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val state = repo.client().crossDomainListenState(listeningToken)
				if (!state.pairingArrived) {
					return@runCatchingCancellable null
				}
				// pairingArrived implies the SAS + all friend keys + the pin are present (the gateway
				// only sets pairingArrived once round 2 records them); guard so a partial reply fails
				// loudly rather than signing a link over blanks.
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

	/** REQUESTER confirm: owner-sign this owner's link over the RECEIVER's keys (from the request
	 * pairing the SAS just verified) and submit it. Only this owner's side is sent; the receiver
	 * confirms its own side independently. `linkNonce` is pinned by the wizard so a retry reuses
	 * the same signed link. */
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

	/** RECEIVER confirm: owner-sign this owner's link over the FRIEND (requester) keys learned from
	 * the listen-state poll and submit it. Uses the pin the poll surfaced (the requester minted it;
	 * the gateway resolves this window's pairing by it). Only this owner's side is sent. */
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

	/** Shared confirm core: owner-sign this owner's link over the friend Gateway's keys, submit it
	 * (the gateway verifies it under this owner's key + writes the cross-Domain peer), then
	 * owner-sign + submit the relay-affinity edge so the Router permits the crosstalk. The local peer
	 * write must succeed (it THROWS otherwise -> Result.failure -> the wizard restarts). The edge
	 * submit RETURNS false (not throws) on a Router rejection: the peer is then linked locally but
	 * cross-Domain sends to it would be DENIED, so the outcome distinguishes the two (RelayEdgeRejected
	 * carries the peer Domain for an edge-only retry) instead of silently reporting a full link. */
	private suspend fun confirmWithMyLink(
		pin: String,
		peerOwnerSignPub: String,
		peerDomainId: String,
		peerGatewayId: String,
		peerSignPub: String,
		peerBoxPub: String,
		linkNonce: String,
	): Result<ConfirmOutcome> = runCatchingCancellable {
		val mySignedLink = repo.federation.signMyLink(
			peerOwnerSignPub = peerOwnerSignPub,
			peerDomainId = peerDomainId,
			peerGatewayId = peerGatewayId,
			peerSignPub = peerSignPub,
			peerBoxPub = peerBoxPub,
			nowMs = System.currentTimeMillis(),
			nonce = linkNonce,
		)
		// Record the OWNER-keyed friend edge (the Users-surface trust) - the SAS confirmed this owner key.
		repo.federation.addTrustedOwner(peerOwnerSignPub)
		repo.client().crossDomainConfirm(pin, mySignedLink)
		// The local peer is now written. The relay-affinity edge is a separate Router submit that
		// returns false on rejection; surface that as RelayEdgeRejected (recoverable by retrying the
		// edge alone) rather than letting the wizard show a false "Linked".
		if (repo.enroll.submitXdomainLink(repo.confirmedDomainIdOrThrow(), peerDomainId)) {
			ConfirmOutcome.Linked
		} else {
			ConfirmOutcome.RelayEdgeRejected(peerDomainId)
		}
	}

	/** Re-submit ONLY the relay-affinity edge for an already-linked peer (the local peer write
	 * happened at confirm; only the Router edge failed). Idempotent at evie (it dedups by nonce), so
	 * this needs no unlink+relink. Returns the same outcome shape so the wizard can loop on a repeat
	 * failure or advance to Done. */
	suspend fun retryXdomainLinkEdge(peerDomainId: String): Result<ConfirmOutcome> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			if (repo.enroll.submitXdomainLink(repo.confirmedDomainIdOrThrow(), peerDomainId)) {
				ConfirmOutcome.Linked
			} else {
				ConfirmOutcome.RelayEdgeRejected(peerDomainId)
			}
		}
	}

	/** A fresh owner-link nonce, pinned by the wizard for one pairing so a confirm retry reuses
	 * the same signed link bytes. */
	fun freshLinkNonce(): String = repo.federation.freshLinkNonce()

	/** Cancel the pairing windows when the owner leaves the link screen (no passive surface). */
	suspend fun crossDomainCancel(listeningToken: String?, pin: String?) = withContext(Dispatchers.IO) {
		runCatchingCancellable { repo.client().crossDomainCancel(listeningToken, pin) }
	}

	////////////////////////////////
	//  Owner-keyed trust (the friend graph the Users surface reads)

	/** True iff this owner has trusted the given owner key (the Users-surface Trusted badge). */
	fun isOwnerTrusted(ownerSignPub: String): Boolean = repo.federation.isTrusted(ownerSignPub)

	/** The set of trusted owner keys (the friend graph). */
	fun trustedOwners(): Set<String> = repo.federation.trustedOwners()

	/** Untrust a person by owner key: drop the local friend edge + sign an owner-keyed untrust
	 * tombstone. The relay-affinity edge teardown (per the peer's Domains) is the gateway-side
	 * follow-up; the friend-graph removal is immediate so the Users surface reflects it now. */
	suspend fun untrustOwner(peerOwnerSignPub: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			// Drop the local friend edge first so the Users surface reflects the untrust immediately.
			repo.federation.removeTrustedOwner(peerOwnerSignPub)
			// Capture the person's Domains BEFORE the local cleanup forgets the peers (a person may run
			// several), so we can revoke each Router-side relay edge. Owner-keyed via the peer set.
			val peerDomains = runCatchingCancellable {
				repo.client().crossDomainListPeers().peers.filter { it.ownerSignPub == peerOwnerSignPub }.map { it.domainId }.toSet()
			}.getOrDefault(emptySet())
			// Tell the gateway to forget every peer + share for this owner across all their Domains
			// (owner-keyed local cleanup). Best-effort: the friend-graph removal already stands even if
			// the gateway is unreachable (a gateway-less owner has no peer state to drop anyway).
			runCatchingCancellable { repo.client().crossDomainUntrust(peerOwnerSignPub) }
			// Router-side: revoke the owner-signed link edge for each of the person's Domains, so evie
			// drops its relay-affinity edge too (the tombstone's relay half, completing the untrust).
			for (d in peerDomains) {
				runCatchingCancellable { repo.enroll.revokeXdomainLink(repo.confirmedDomainIdOrThrow(), d) }
			}
			Unit
		}
	}

	////////////////////////////////
	//  FLOW-2 trust rendezvous (roster-initiated user-to-user trust)

	/** The sorted-owner-key role both sides agree on for the SYMMETRIC FLOW-2 SAS: the lower owner key
	 * takes the ADMIN slot, so both phones hash the two parties in the SAME order. Reuses enrollSas /
	 * enrollCommitment - no new SAS scheme (the rendezvousId is the pin). */
	private fun trustRole(myOwner: String, peerOwner: String): String =
		if (myOwner < peerOwner) EnrollCeremony.ADMIN else EnrollCeremony.ENROLLEE

	/** Mint a fresh rendezvous id (the initiator's; also the SAS pin both sides bind). */
	fun mintRendezvousId(): String = repo.federation.freshRendezvousId()

	/** Poll "who armed trust toward me?" (the highlight). Returns the armed initiator rows (owner key
	 * + rendezvousId) so the Users surface highlights them. Best-effort. */
	suspend fun fetchPendingTrust(): Result<List<com.atelier_nyaarium.switchboard.proto.TrustPendingEntry>> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val r = repo.client().trustPending(repo.federation.signTrustPendingRequest(System.currentTimeMillis()))
				if (!r.ok) error(r.error ?: "trust pending unavailable")
				r.pending ?: emptyList()
			}
		}

	/** Run one side of the FLOW-2 commit-reveal compare over the rendezvous. `mySide` is INITIATOR (I
	 * armed) or TARGET (I joined a highlighted arm). Mirrors `enrollExchange`: commit (arm/join) ->
	 * poll peerCommit -> reveal -> poll peerReveal -> verify the commit-reveal binding + that the peer
	 * revealed the OWNER the rendezvous named -> compute the SAS. The result's `peerParty`/`peerDomainId`
	 * feed `enrollConfirm` (shared trust-confirm) on a [Yes]. */
	suspend fun trustExchange(
		rendezvousId: String,
		mySide: String,
		peerOwnerSignPub: String,
	): Result<EnrollExchange> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val myParty = repo.federation.trustParty(repo.confirmedDomainIdOrThrow())
				val myRole = trustRole(myParty.ownerSignPub, peerOwnerSignPub)
				val peerRole = EnrollCeremony.peerRole(myRole)
				val salt = repo.federation.freshEnrollSalt()
				val myReveal = com.atelier_nyaarium.switchboard.proto.EnrollReveal(
					myParty.ownerSignPub,
					myParty.ownerBoxPub,
					myParty.domainId,
					salt,
				)
				val commitment = SasCrypto.enrollCommitment(myParty, myRole, salt)

				// Round 1: commit (the initiator ARMs, the target JOINs), then poll for the peer's.
				val peerCommitment = pollEnroll("commit") {
					val op = if (mySide == TRUST_SIDE_INITIATOR) {
						TrustHandshakeOp.Arm(rendezvousId, myParty.ownerSignPub, peerOwnerSignPub, commitment)
					} else {
						TrustHandshakeOp.Join(rendezvousId, myParty.ownerSignPub, commitment)
					}
					val r = repo.client().trustHandshake(op)
					if (!r.ok) error(r.error ?: "trust commit rejected")
					r.peerCommitment
				}
				// Round 2: reveal, then poll for the peer's reveal.
				val peerReveal = pollEnroll("reveal") {
					val r = repo.client().trustHandshake(TrustHandshakeOp.Reveal(rendezvousId, mySide, myReveal))
					if (!r.ok) error(r.error ?: "trust reveal rejected")
					r.peerReveal
				}
				val peerParty = EnrollCeremony.partyOf(peerReveal)
				// Commit-reveal binding: the peer's reveal must open to its round-1 commitment.
				if (!EnrollCeremony.verifyPeer(peerCommitment, peerParty, peerRole, peerReveal.salt)) {
					error("The other phone's keys did not match its commitment (the relay tampered with the exchange). Try again.")
				}
				// Anti-substitution: the peer must reveal the OWNER the rendezvous named (the arm /
				// highlight bound peerOwnerSignPub), so evie cannot splice in a different person.
				if (peerParty.ownerSignPub != peerOwnerSignPub) {
					error("The other person's identity did not match the trust request. Try again.")
				}
				EnrollExchange(
					sas = EnrollCeremony.sas(myRole, myParty, peerParty, rendezvousId),
					peerDomainId = peerReveal.domainId,
					peerParty = peerParty,
				)
			}
		}

	/** Cancel this leg of the trust rendezvous (a [No], timeout, or leaving). Best-effort. */
	suspend fun trustCancel(rendezvousId: String) = withContext(Dispatchers.IO) {
		runCatchingCancellable { repo.client().trustHandshake(TrustHandshakeOp.Cancel(rendezvousId)) }
	}

	/** This owner's current per-session SPECIFIC-Domain shares as (sessionTarget, domainId) pairs, so
	 * the per-peer checkmark UI can render them (everyone-trusted shares are a separate mode). */
	suspend fun crossDomainShares(): Result<Set<Pair<String, String>>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			repo.client().crossDomainListShares().shares
				.mapNotNull { e ->
					(e.target as? com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain)?.let {
						e.sessionTarget to it.domainId
					}
				}
				.toSet()
		}
	}

	/** How many of MY sessions each TRUSTED person can reach, keyed by their owner key (the Users
	 * row's "N shared sessions"). A person reaches a session shared to one of their Domains OR shared
	 * to everyone-trusted. Joins the peer set (owner -> their Domains) with the share list. */
	suspend fun sharedSessionCounts(): Result<Map<String, Int>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val ownerDomains = repo.client().crossDomainListPeers().peers
				.filter { it.ownerSignPub.isNotEmpty() }
				.groupBy({ it.ownerSignPub }, { it.domainId })
			val shares = repo.client().crossDomainListShares().shares
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

	/** The sessions shared to EVERYONE the owner trusts (the Users-surface share mode). */
	suspend fun sessionsSharedToEveryone(): Result<Set<String>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			repo.client().crossDomainListShares().shares
				.filter { it.target is com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted }
				.map { it.sessionTarget }
				.toSet()
		}
	}

	/** Toggle a local session's share to a specific friend Domain (the checkmark IS the consent). */
	suspend fun setCrossDomainShare(sessionTarget: String, domainId: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain(domainId)
				if (shared) repo.client().crossDomainShare(sessionTarget, target) else repo.client().crossDomainUnshare(sessionTarget, target)
				Unit
			}
		}

	/** Toggle a local session's share to EVERYONE the owner trusts (the live-trust-set audience). */
	suspend fun setShareEveryoneTrusted(sessionTarget: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted
				if (shared) repo.client().crossDomainShare(sessionTarget, target) else repo.client().crossDomainUnshare(sessionTarget, target)
				Unit
			}
		}

	/** Unlink a friend Domain: forget the local trust + shares for it, then owner-sign + submit
	 * the link-edge revocation so the Router drops its relay-affinity edge. crossDomainUnlink's own
	 * server-side removal already bumps the linked-peers plane (see CrossDomainPeers' onChange
	 * hook), which wakes this device's own currently-held poll for free - no client-side action
	 * needed for that half. Mesh-wide discovery has no such push (see refreshDiscovery's own doc),
	 * so an explicit pull is still what makes the unlinked peer's sessions actually disappear from
	 * the board promptly instead of waiting out DISCOVERY_REFRESH_MS. */
	suspend fun unlinkDomain(domainId: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			repo.client().crossDomainUnlink(domainId)
			repo.enroll.revokeXdomainLink(repo.confirmedDomainIdOrThrow(), domainId)
			repo.refreshDiscovery()
			Unit
		}
	}

	private fun newRendezvousPin(): String {
		val bytes = ByteArray(18)
		java.security.SecureRandom().nextBytes(bytes)
		return android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
	}
}
