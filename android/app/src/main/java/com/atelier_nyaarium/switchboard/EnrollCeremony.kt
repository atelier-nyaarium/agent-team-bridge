package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollParty
import com.atelier_nyaarium.switchboard.proto.EnrollReveal
import com.atelier_nyaarium.switchboard.proto.SasCrypto

/**
 * Pure (Android-free) core of the FLOW-1 in-person enroll ceremony: the role pairing, the
 * role-ordered SAS derivation, and the commit-reveal verification a phone runs against the
 * UNTRUSTED evie broker. Kept here so a JVM unit test pins the security-critical decisions (the
 * peer-commitment binding, the admin-key QR pin, the role ordering the SAS hashes over) without a
 * device - the same split as CrossDomainLink.kt / FriendOnboarding.kt. The networked commit /
 * reveal / submit orchestration lives in ChatRepository.
 *
 * evie only relays the two phones' commit then reveal frames; it never computes this SAS and never
 * verifies a commitment. Every check below is local to the phone, so a substituted key surfaces as
 * a commitment mismatch or a diverging compare code, not a trusted-because-evie-said-so frame.
 */

////////////////////////////////
//  Interfaces & Types

/** One leg of the in-person enroll compare. The ADMIN (showed the QR) and the ENROLLEE (scanned it)
 * each build their own context: the shared handshakeId + pin (the pin rides the QR out of band and
 * is never sent to evie), this owner's party, and - for the enrollee only - the admin party pinned
 * from the QR, so a substituted admin reveal is caught immediately rather than only at the compare. */
data class EnrollCeremonyContext(
	val role: String,
	val handshakeId: String,
	val pin: String,
	val myParty: EnrollParty,
	/** The admin's party as pinned from the scanned QR (enrollee side); null on the admin side,
	 * which has no out-of-band knowledge of the fresh enrollee's keys and relies on the compare. */
	val expectedPeer: EnrollParty? = null,
)

/** The product of the commit-reveal exchange the human then confirms: the compare code, the peer's
 * confirmed Domain id (signed into the link edge on [Yes] - the EXACT value the SAS was computed
 * over, never a re-fetch), and the peer's party. */
data class EnrollExchange(val sas: String, val peerDomainId: String, val peerParty: EnrollParty)

/** The ceremony's step, a linear progression with terminal done/error states (mirrors LinkStep).
 * The UI renders one panel per step. */
sealed interface EnrollStep {
	/** Committing this side and polling the broker for the peer's commit + reveal. */
	data object Waiting : EnrollStep

	/** Both phones computed the compare code; the humans glance-compare and tap [Yes] / [No]. */
	data class Compare(val sas: String, val exchange: EnrollExchange) : EnrollStep

	/** Both link edges submitted: the admin <-> user trust is committed. */
	data object Done : EnrollStep

	/** The local trust is recorded but the Router rejected the relay-affinity edge, so cross-Domain
	 * sends would be denied; carries the peer Domain for the one-tap edge-only retry. */
	data class LinkedNoRelay(val peerDomainId: String) : EnrollStep

	/** A terminal failure (mismatch, cap, timeout, transport, or a [No] decline). */
	data class Failed(val reason: String) : EnrollStep
}

/** The admin-minted, per-invite enroll secrets embedded in the QR and reused to drive the admin's
 * leg of the compare. Transient (in-memory): the in-person flow keeps the detail screen open; a
 * process restart means regenerate the invite (the friend rescans). */
data class EnrollInvite(val handshakeId: String, val pin: String)

////////////////////////////////
//  Functions & Helpers

object EnrollCeremony {
	const val ADMIN = "ADMIN"
	const val ENROLLEE = "ENROLLEE"

	fun peerRole(role: String): String = if (role == ADMIN) ENROLLEE else ADMIN

	/** The party object a peer's reveal carries (the keys + Domain it bound into its commitment). */
	fun partyOf(reveal: EnrollReveal): EnrollParty =
		EnrollParty(reveal.ownerSignPub, reveal.ownerBoxPub, reveal.domainId)

	/** True iff the peer's reveal opens to its round-1 commitment - the commit-reveal binding. evie
	 * does not check this (it is a dumb broker); the phone re-hashes the revealed keys+salt under the
	 * peer's role and aborts on a mismatch, so a relay that swapped a key in the reveal is caught. */
	fun verifyPeer(peerCommitment: String, peerParty: EnrollParty, peerRole: String, peerSalt: String): Boolean =
		SasCrypto.verifyEnrollCommitment(peerCommitment, peerParty, peerRole, peerSalt)

	/** The 6-digit compare code for this leg. Both phones must hash the two parties in the SAME slot
	 * order (ADMIN block then ENROLLEE block), so order by role rather than by which side I am - the
	 * preimage is role-tagged and NOT order-independent (unlike the gateway's flat-sorted SAS). */
	fun sas(role: String, myParty: EnrollParty, peerParty: EnrollParty, pin: String): String {
		val admin = if (role == ADMIN) myParty else peerParty
		val enrollee = if (role == ADMIN) peerParty else myParty
		return SasCrypto.enrollSas(admin, enrollee, pin)
	}
}
