package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollParty
import com.atelier_nyaarium.switchboard.proto.EnrollReveal
import com.atelier_nyaarium.switchboard.proto.SasCrypto
import kotlinx.coroutines.delay

/** The networked half of the commit-reveal compare, run by both federation flows: a check added
 * here cannot reach one and miss the other. Android-free, so a JVM test drives it with a fake broker. */

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

/** Run one leg to the human compare. [authenticatePeer] is the flow's own out-of-band binding and
 * returns an abort message, so an unauthenticated peer can never reach the compare. [retryHint] ends
 * the tamper message with the recovery this flow actually has. Cancellation propagates. */
internal suspend fun runSasExchange(
	myParty: EnrollParty,
	myRole: String,
	pin: String,
	salt: String,
	retryHint: String,
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
		error("The other phone's keys did not match its commitment (the relay tampered with the exchange). $retryHint")
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
