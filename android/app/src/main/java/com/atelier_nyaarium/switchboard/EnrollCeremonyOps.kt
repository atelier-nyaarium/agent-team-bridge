package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeOp
import com.atelier_nyaarium.switchboard.proto.EnrollParty
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal interface EnrollCeremonyOpsCollaborators {
	fun enrollInvites(): MutableMap<String, EnrollInvite>
	fun ownerBoxPub(): String
	fun freshEnrollSalt(): String
	fun addTrustedOwner(ownerSignPub: String)
	suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String, edgeNonce: String): Boolean
}

internal class EnrollCeremonyOps(
	private val store: AppStateStore,
	private val identity: IdentityPort,
	private val client: ClientPort,
	private val collaborators: EnrollCeremonyOpsCollaborators,
) {

	fun adminEnrollContext(domainId: String): EnrollCeremonyContext? {
		val invite = collaborators.enrollInvites()[domainId] ?: return null
		val boot = identity.readyOrNull() ?: return null
		val adminDomain = boot.domainId
		val myParty = EnrollParty(boot.ownerSignPub, collaborators.ownerBoxPub(), adminDomain)
		return EnrollCeremonyContext(EnrollCeremony.ADMIN, invite.handshakeId, invite.pin, myParty, expectedPeer = null)
	}

	fun enrolleeEnrollContext(): EnrollCeremonyContext? {
		val prov = runCatching { store.load()?.let { ConsoleCredentials.parse(it, store) } }.getOrNull() ?: return null
		val hs = prov.enrollHandshake ?: return null
		val myDomainId = prov.pendingTenant?.domainId ?: return null
		val boot = identity.readyOrNull() ?: return null
		val myParty = EnrollParty(boot.ownerSignPub, boot.consoleIdentity.box.pub, myDomainId)
		val adminParty = EnrollParty(hs.adminOwnerSignPub, hs.adminOwnerBoxPub, hs.adminDomainId)
		return EnrollCeremonyContext(EnrollCeremony.ENROLLEE, hs.handshakeId, hs.pin, myParty, expectedPeer = adminParty)
	}

	fun pendingEnrolleeCeremony(): EnrollCeremonyContext? =
		if (store.enrollCeremonyDone) null else enrolleeEnrollContext()

	fun markEnrolleeCeremonyDone() {
		store.enrollCeremonyDone = true
	}

	suspend fun enrollExchange(ctx: EnrollCeremonyContext): Result<EnrollExchange> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			runSasExchange(
				myParty = ctx.myParty,
				myRole = ctx.role,
				pin = ctx.pin,
				salt = collaborators.freshEnrollSalt(),
				retryHint = "Rescan to restart.",
				transport = object : SasTransport {
					override suspend fun commit(commitment: String): String? {
						val r = client.client().enrollHandshake(EnrollHandshakeOp.Commit(ctx.handshakeId, ctx.role, commitment))
						if (!r.ok) error(r.error ?: "enroll commit rejected")
						return r.peerCommitment
					}

					override suspend fun reveal(myReveal: com.atelier_nyaarium.switchboard.proto.EnrollReveal) =
						client.client().enrollHandshake(EnrollHandshakeOp.Reveal(ctx.handshakeId, ctx.role, myReveal)).let {
							if (!it.ok) error(it.error ?: "enroll reveal rejected")
							it.peerReveal
						}
				},
				// QR-pinned peer identity rejects substitutions after the SAS exchange.
				authenticatePeer = { EnrollCeremony.qrMismatch(ctx.expectedPeer, it) },
			)
		}
	}

	suspend fun enrollConfirm(
		myDomainId: String,
		peerDomainId: String,
		edgeNonce: String,
		peerOwnerSignPub: String,
	): Result<ConfirmOutcome> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				// Record the owner-keyed trust edge before relay submission.
				collaborators.addTrustedOwner(peerOwnerSignPub)
				// Reuse the edge nonce so Router deduplication holds.
				if (collaborators.submitXdomainLink(myDomainId, peerDomainId, edgeNonce)) {
					ConfirmOutcome.Linked
				} else {
					ConfirmOutcome.RelayEdgeRejected(peerDomainId)
				}
			}
		}

	suspend fun enrollCancel(handshakeId: String, role: String) = withContext(Dispatchers.IO) {
		// Cancellation is best-effort cleanup of the broker window.
		runCatchingCancellable { client.client().enrollHandshake(EnrollHandshakeOp.Cancel(handshakeId, role)) }
	}
}
