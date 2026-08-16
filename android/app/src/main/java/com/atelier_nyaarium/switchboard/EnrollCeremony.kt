package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollParty
import com.atelier_nyaarium.switchboard.proto.EnrollReveal
import com.atelier_nyaarium.switchboard.proto.SasCrypto

/**
 * Pure (Android-free) core of the in-person enroll ceremony: role pairing, role-ordered SAS
 * derivation, the commit-reveal verification, and each flow's out-of-band peer binding, all run
 * against the untrusted Router broker. The networked walk is SasExchange.kt; the transports are
 * EnrollCeremonyOps.kt and TrustOps.kt.
 *
 * The Router only relays the two phones' commit then reveal frames; it never computes this SAS and
 * never verifies a commitment. Every check below is local to the phone, so a substituted key
 * surfaces as a commitment mismatch or a diverging compare code.
 */

////////////////////////////////
//  Interfaces & Types

/** One leg of the in-person enroll compare. The admin (showed the QR) and the enrollee (scanned it)
 * each build their own context: the shared handshakeId, the pin (rides the QR out of band, never
 * sent to the Router), this owner's party, and on the enrollee side the admin party pinned from the QR. */
data class EnrollCeremonyContext(
	val role: String,
	val handshakeId: String,
	val pin: String,
	val myParty: EnrollParty,
	/** The admin's party pinned from the scanned QR (enrollee side); null on the admin side, which
	 * has no out-of-band knowledge of the enrollee's keys and relies on the compare. */
	val expectedPeer: EnrollParty? = null,
)

/** The product of the commit-reveal exchange the human confirms: the compare code, the peer's
 * confirmed Domain id (signed into the link edge on Yes, the exact value the SAS was computed over,
 * never a re-fetch), and the peer's party. */
data class EnrollExchange(val sas: String, val peerDomainId: String, val peerParty: EnrollParty)

/** The ceremony's linear step progression with terminal done/error states. The UI renders one panel
 * per step. */
sealed interface EnrollStep {
	/** Committing this side and polling the broker for the peer's commit + reveal. */
	data object Waiting : EnrollStep

	/** Both phones computed the compare code; the humans glance-compare and tap [Yes] / [No]. */
	data class Compare(val sas: String, val exchange: EnrollExchange) : EnrollStep

	/** Both link edges submitted: the admin <-> user trust is committed. */
	data object Done : EnrollStep

	/** Local trust is recorded but the Router rejected the relay-affinity edge, so cross-Domain
	 * sends would be denied; carries the peer Domain + owner for the one-tap edge-only retry. */
	data class LinkedNoRelay(val peerDomainId: String, val peerOwnerSignPub: String) : EnrollStep

	/** A terminal failure (mismatch, cap, timeout, transport, or a [No] decline). */
	data class Failed(val reason: String) : EnrollStep
}

/** The admin-minted, per-invite enroll secrets embedded in the QR. Transient (in-memory): a process
 * restart means regenerating the invite so the friend rescans. */
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

	/** True iff the peer's reveal opens to its round-1 commitment - the commit-reveal binding. The
	 * phone re-hashes the revealed keys+salt under the peer's role and aborts on a mismatch, so a
	 * relay that swapped a key in the reveal is caught. The Router does not check this. */
	fun verifyPeer(peerCommitment: String, peerParty: EnrollParty, peerRole: String, peerSalt: String): Boolean =
		SasCrypto.verifyEnrollCommitment(peerCommitment, peerParty, peerRole, peerSalt)

	/** The 6-digit compare code for this leg. Both phones must hash the two parties in the same slot
	 * order (ADMIN block then ENROLLEE block), so order by role rather than by which side I am: the
	 * preimage is role-tagged and not order-independent. */
	fun sas(role: String, myParty: EnrollParty, peerParty: EnrollParty, pin: String): String {
		val admin = if (role == ADMIN) myParty else peerParty
		val enrollee = if (role == ADMIN) peerParty else myParty
		return SasCrypto.enrollSas(admin, enrollee, pin)
	}

	/** FLOW-1's out-of-band binding: the admin's revealed keys must equal the scanned QR, so the Router
	 * cannot substitute the admin reveal. A null [expectedPeer] is the admin's own leg, which has no
	 * out-of-band knowledge of the enrollee and relies on the compare. Returns the abort message. */
	fun qrMismatch(expectedPeer: EnrollParty?, peerParty: EnrollParty): String? =
		if (expectedPeer != null && peerParty != expectedPeer) {
			"The admin keys did not match the scanned code (possible tampering). Rescan to restart."
		} else {
			null
		}

	/** FLOW-2's out-of-band binding: the peer must reveal the OWNER the rendezvous named, so the Router
	 * cannot splice in a different person. Returns the abort message. */
	fun ownerMismatch(expectedOwnerSignPub: String, peerParty: EnrollParty): String? =
		if (peerParty.ownerSignPub != expectedOwnerSignPub) {
			"The other person's identity did not match the trust request. Try again."
		} else {
			null
		}
}
