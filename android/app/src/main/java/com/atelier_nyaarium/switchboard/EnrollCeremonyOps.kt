package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeOp
import com.atelier_nyaarium.switchboard.proto.EnrollParty
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The repository side of the FLOW-1 in-person compare: each leg's context, the brokered exchange,
 * and the confirm/cancel outcomes. The pure engine stays in SasExchange.kt / EnrollCeremony.kt. */
internal class EnrollCeremonyOps(private val repo: ChatRepository) {
	////////////////////////////////
	//  FLOW-1 enroll ceremony (the in-person admin <-> new-user trust compare, brokered by evie)

	/** The ADMIN leg context for a staged tenant's in-person compare: the handshakeId + pin the
	 * invite embedded (minted on buildInviteBlob) plus this owner's party. Null until the admin has
	 * generated the invite (so the QR and the ceremony share one handshake window). */
	fun adminEnrollContext(domainId: String): EnrollCeremonyContext? {
		val invite = repo.enrollInvites[domainId] ?: return null
		val adminDomain = repo.confirmedDomainId() ?: return null
		val myParty = EnrollParty(repo.federation.ownerSignPub(), repo.federation.ownerBoxPub(), adminDomain)
		return EnrollCeremonyContext(EnrollCeremony.ADMIN, invite.handshakeId, invite.pin, myParty, expectedPeer = null)
	}

	/** The ENROLLEE leg context after first-rooting an invited Domain: the handshakeId + pin + admin
	 * party read from the scanned blob, plus this owner's freshly-rooted party. The admin party is
	 * carried as `expectedPeer` so a substituted admin reveal is caught against the in-person QR, not
	 * only at the compare. Null when the blob carries no enroll handshake (an ordinary invite). The
	 * Domain id is taken from the blob's pendingTenant (the EXACT Domain this device just rooted), NOT
	 * confirmedDomainId() - which is null until a local discovery session lands. */
	fun enrolleeEnrollContext(): EnrollCeremonyContext? {
		val prov = runCatching { repo.store.load()?.let { Provisioning.parse(it) } }.getOrNull() ?: return null
		val hs = prov.enrollHandshake ?: return null
		val myDomainId = prov.pendingTenant?.domainId ?: return null
		val myParty = EnrollParty(repo.federation.ownerSignPub(), repo.federation.ownerBoxPub(), myDomainId)
		val adminParty = EnrollParty(hs.adminOwnerSignPub, hs.adminOwnerBoxPub, hs.adminDomainId)
		return EnrollCeremonyContext(EnrollCeremony.ENROLLEE, hs.handshakeId, hs.pin, myParty, expectedPeer = adminParty)
	}

	/** The enrollee leg to run (or re-offer), or null when the blob carries no enroll handshake or the
	 * in-person compare is already done. Drives the post-first-root auto-launch and the board's
	 * "Verify with the admin" prompt - both go quiet once [markEnrolleeCeremonyDone] latches. */
	fun pendingEnrolleeCeremony(): EnrollCeremonyContext? =
		if (repo.store.enrollCeremonyDone) null else enrolleeEnrollContext()

	/** Latch the enrollee compare as complete so it stops being offered (the trust edge is recorded). */
	fun markEnrolleeCeremonyDone() {
		repo.store.enrollCeremonyDone = true
	}

	/** The FLOW-1 leg to the human compare. evie is a dumb broker: every check is on the phone. */
	suspend fun enrollExchange(ctx: EnrollCeremonyContext): Result<EnrollExchange> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			runSasExchange(
				myParty = ctx.myParty,
				myRole = ctx.role,
				pin = ctx.pin,
				salt = repo.federation.freshEnrollSalt(),
				// This flow's recovery is the QR the enrollee still has.
				retryHint = "Rescan to restart.",
				transport = object : SasTransport {
					override suspend fun commit(commitment: String): String? {
						val r = repo.client().enrollHandshake(EnrollHandshakeOp.Commit(ctx.handshakeId, ctx.role, commitment))
						if (!r.ok) error(r.error ?: "enroll commit rejected")
						return r.peerCommitment
					}

					override suspend fun reveal(myReveal: com.atelier_nyaarium.switchboard.proto.EnrollReveal) =
						repo.client().enrollHandshake(EnrollHandshakeOp.Reveal(ctx.handshakeId, ctx.role, myReveal)).let {
							if (!it.ok) error(it.error ?: "enroll reveal rejected")
							it.peerReveal
						}
				},
				authenticatePeer = { EnrollCeremony.qrMismatch(ctx.expectedPeer, it) },
			)
		}
	}

	/** On a mutual [Yes]: owner-sign + submit this side's cross-Domain link edge (my Domain -> the
	 * peer's CONFIRMED Domain - the EXACT value the SAS bound, never a re-fetch). Mirrors the link
	 * wizard's edge result: Linked, or RelayEdgeRejected (the trust is recorded but the Router refused
	 * the relay edge, retryable). */
	suspend fun enrollConfirm(
		myDomainId: String,
		peerDomainId: String,
		edgeNonce: String,
		peerOwnerSignPub: String,
	): Result<ConfirmOutcome> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				// Record the OWNER-keyed friend edge first (the Users-surface trust): the compare confirmed
				// the peer's owner key, so trust the PERSON even if the relay edge below is rejected (a
				// gateway-less friend still becomes a friend; relay enables later).
				repo.federation.addTrustedOwner(peerOwnerSignPub)
				// Pin the edge nonce so a retry / lost-ack re-submit re-signs the SAME edge (evie dedupes
				// by (src, nonce)) instead of accumulating a duplicate per attempt.
				if (repo.ownerFacts.submitXdomainLink(myDomainId, peerDomainId, edgeNonce)) {
					ConfirmOutcome.Linked
				} else {
					ConfirmOutcome.RelayEdgeRejected(peerDomainId)
				}
			}
		}

	/** Cancel this leg of the handshake (a [No], a timeout, or leaving the screen) so the broker tears
	 * the window down rather than leaving a half-formed edge. Best-effort. */
	suspend fun enrollCancel(handshakeId: String, role: String) = withContext(Dispatchers.IO) {
		runCatchingCancellable { repo.client().enrollHandshake(EnrollHandshakeOp.Cancel(handshakeId, role)) }
	}
}
