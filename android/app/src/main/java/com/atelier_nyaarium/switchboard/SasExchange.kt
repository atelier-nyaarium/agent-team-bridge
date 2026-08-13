package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollParty
import com.atelier_nyaarium.switchboard.proto.EnrollReveal
import com.atelier_nyaarium.switchboard.proto.SasCrypto
import kotlinx.coroutines.delay

/**
 * The networked half of the commit-reveal compare, run identically by the FLOW-1 enroll ceremony and
 * the FLOW-2 trust rendezvous: commit, poll for the peer's commitment, reveal, poll for the peer's
 * reveal, verify the binding, authenticate the peer, then derive the SAS locally.
 *
 * Android-free so a JVM test drives the security decisions with fake transports. Both flows call
 * [runSasExchange], so a check added here cannot reach one flow and miss the other.
 */

////////////////////////////////
//  Interfaces & Types

/** How one flow reaches its broker. Both frames are idempotent at the broker, so a poll re-POSTs. */
internal interface SasTransport {
	/** Post this side's commitment; returns the peer's once the broker has it. */
	suspend fun commit(commitment: String): String?

	/** Post this side's reveal; returns the peer's once the broker has it. */
	suspend fun reveal(myReveal: EnrollReveal): EnrollReveal?
}

////////////////////////////////
//  Functions & Helpers

/**
 * Run one leg to the human compare. [authenticatePeer] is the flow's own out-of-band binding
 * (FLOW-1 pins the admin party from the QR; FLOW-2 pins the owner key the rendezvous named) and
 * returns a message to abort with, so an unauthenticated peer can never reach the compare.
 * Throws on a terminal broker reject, tamper, or timeout; cancellation propagates.
 */
internal suspend fun runSasExchange(
	myParty: EnrollParty,
	myRole: String,
	pin: String,
	salt: String,
	transport: SasTransport,
	authenticatePeer: (EnrollParty) -> String?,
): EnrollExchange {
	val myReveal = EnrollReveal(myParty.ownerSignPub, myParty.ownerBoxPub, myParty.domainId, salt)
	val commitment = SasCrypto.enrollCommitment(myParty, myRole, salt)
	val peerRole = EnrollCeremony.peerRole(myRole)

	val peerCommitment = pollEnroll("commit") { transport.commit(commitment) }
	val peerReveal = pollEnroll("reveal") { transport.reveal(myReveal) }

	val peerParty = EnrollCeremony.partyOf(peerReveal)
	// Commit-reveal binding: the peer's reveal must open to its round-1 commitment.
	if (!EnrollCeremony.verifyPeer(peerCommitment, peerParty, peerRole, peerReveal.salt)) {
		error("The other phone's keys did not match its commitment (the relay tampered with the exchange). Try again.")
	}
	authenticatePeer(peerParty)?.let { error(it) }
	return EnrollExchange(
		sas = EnrollCeremony.sas(myRole, myParty, peerParty, pin),
		peerDomainId = peerReveal.domainId,
		peerParty = peerParty,
	)
}

/** Poll one handshake step until it returns the peer's frame, bounded so a vanished peer fails
 * rather than hangs. [step] throws on a terminal broker reject, which propagates out. */
internal suspend fun <T> pollEnroll(label: String, step: suspend () -> T?): T {
	repeat(ENROLL_POLL_MAX) {
		step()?.let { return it }
		delay(ENROLL_POLL_MS)
	}
	error("Timed out waiting for the other phone ($label). Make sure you are both on this screen, then rescan.")
}
