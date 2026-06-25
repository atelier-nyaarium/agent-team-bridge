package com.atelier_nyaarium.switchboard.proto

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

/**
 * Cross-Domain pairing SAS + commitment (commit-reveal SAS-AKE). Hand-authored twin of
 * src/shared/cross-domain-sas.ts, kept equivalent by tests/fixtures/cross-domain-sas/vectors.json
 * (read by both runtimes).
 *
 * The handshake is an unauthenticated key exchange between two owners' Gateways relayed by the
 * content-blind Router. A bare SAS over only the public keys + the pin is offline grindable, so
 * each side first publishes a hiding commitment to its own keys+ids; the SAS then binds the
 * committed keys + both sides' ids + the pin. To reproduce the TS values byte-for-byte, the
 * derivation uses only SHA-256 + big-endian BigInteger math.
 */

////////////////////////////////
//  Interfaces & Types

/**
 * One side's committed identity. Both the commitment and the SAS are computed over these fields
 * in this exact order, so the two runtimes must assemble them identically.
 */
data class CrossDomainParty(
	val ownerSignPub: String,
	val gatewaySignPub: String,
	val gatewayBoxPub: String,
	val domainId: String,
	val gatewayId: String,
)

/**
 * One owner side of an enroll handshake. No gateway fields, because the enrollee is gateway-less
 * at enroll time. Twin of EnrollParty in cross-domain-sas.ts.
 */
data class EnrollParty(
	val ownerSignPub: String,
	val ownerBoxPub: String,
	val domainId: String,
)

////////////////////////////////
//  Class

object SasCrypto {
	// The displayed safety code is six decimal digits, shown as two groups of three. Six keeps the
	// post-commitment online-guess space negligible (1-in-10^6) while staying easy to compare.
	private const val SAS_DIGITS = 6

	// The modulus the digest reduces to. A BigInteger because the digest value `n` it reduces is a
	// BigInteger (the 8 digest bytes reach ~1.8e19).
	private val SAS_MODULUS: BigInteger = BigInteger.TEN.pow(SAS_DIGITS)

	////////////////////////////////
	//  Commitment

	/**
	 * The canonical commitment preimage for one side: the literal `SAS_COMMIT_V1`, then
	 * that side's five identity fields in fixed order, then the side's random salt - all
	 * newline-joined, UTF-8.
	 */
	fun crossDomainCommitmentPreimage(party: CrossDomainParty, salt: String): ByteArray =
		listOf(
			"SAS_COMMIT_V1",
			party.ownerSignPub,
			party.gatewaySignPub,
			party.gatewayBoxPub,
			party.domainId,
			party.gatewayId,
			salt,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	/**
	 * A side's hiding commitment to its own keys+ids: SHA-256 of the canonical commitment preimage,
	 * base64. The peer re-derives it from the revealed keys+ids+salt and aborts on a mismatch.
	 */
	fun crossDomainCommitment(party: CrossDomainParty, salt: String): String =
		Base64.getEncoder().encodeToString(sha256(crossDomainCommitmentPreimage(party, salt)))

	/**
	 * True iff `commitment` is the commitment a side would have produced for these
	 * revealed keys+ids+salt (the commit-reveal binding).
	 */
	fun verifyCrossDomainCommitment(commitment: String, party: CrossDomainParty, salt: String): Boolean =
		crossDomainCommitment(party, salt) == commitment

	////////////////////////////////
	//  SAS

	/**
	 * The canonical SAS preimage: the literal `SAS_V1`, then BOTH sides' five identity fields
	 * SORTED lexicographically, then the pin, all newline-joined UTF-8.
	 *
	 * The fields are sorted as a flat list so the result is order-independent: each side holds the
	 * same ten identity fields and sorts them to the same sequence regardless of which side it is.
	 */
	fun crossDomainSasPreimage(a: CrossDomainParty, b: CrossDomainParty, pin: String): ByteArray {
		val fields = listOf(
			a.ownerSignPub,
			a.gatewaySignPub,
			a.gatewayBoxPub,
			a.domainId,
			a.gatewayId,
			b.ownerSignPub,
			b.gatewaySignPub,
			b.gatewayBoxPub,
			b.domainId,
			b.gatewayId,
		).sorted()
		return (listOf("SAS_V1") + fields + listOf(pin)).joinToString("\n").toByteArray(Charsets.UTF_8)
	}

	/** The displayed safety code for the cross-Domain preimage (see reduceToSas). */
	fun crossDomainSas(a: CrossDomainParty, b: CrossDomainParty, pin: String): String =
		reduceToSas(crossDomainSasPreimage(a, b, pin))

	////////////////////////////////
	//  Enroll SAS (owner-anchored, role-tagged)
	//
	//  Twin of the enroll* helpers in cross-domain-sas.ts: the in-person admin<->enrollee compare
	//  brokered by an untrusted evie. Owner-anchored (no gateway keys) with FIXED-SLOT role-tagged
	//  ADMIN / ENROLLEE blocks, so the preimage is injective and evie cannot transpose the blocks.
	//  The reduction + salted commitment match crossDomainSas; only the preimage shape + version
	//  literals differ. Pinned by tests/fixtures/enroll-sas/vectors.json. Role is "ADMIN" (showed
	//  the QR) or "ENROLLEE" (scanned).

	fun enrollCommitmentPreimage(party: EnrollParty, role: String, salt: String): ByteArray =
		listOf(
			"ENROLL_COMMIT_V1",
			role,
			party.ownerSignPub,
			party.ownerBoxPub,
			party.domainId,
			salt,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun enrollCommitment(party: EnrollParty, role: String, salt: String): String =
		Base64.getEncoder().encodeToString(sha256(enrollCommitmentPreimage(party, role, salt)))

	fun verifyEnrollCommitment(commitment: String, party: EnrollParty, role: String, salt: String): Boolean =
		enrollCommitment(party, role, salt) == commitment

	fun enrollSasPreimage(admin: EnrollParty, enrollee: EnrollParty, pin: String): ByteArray =
		listOf(
			"ENROLL_SAS_V1",
			"ADMIN",
			admin.ownerSignPub,
			admin.ownerBoxPub,
			admin.domainId,
			"ENROLLEE",
			enrollee.ownerSignPub,
			enrollee.ownerBoxPub,
			enrollee.domainId,
			pin,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun enrollSas(admin: EnrollParty, enrollee: EnrollParty, pin: String): String =
		reduceToSas(enrollSasPreimage(admin, enrollee, pin))

	////////////////////////////////
	//  Functions & Helpers

	/**
	 * Reduce a SAS preimage to the displayed code: SHA-256, read the FIRST 8 digest bytes as a
	 * big-endian unsigned integer, reduce mod 10^6, zero-pad to 6 digits. Shared by every SAS
	 * derivation; the per-derivation preimage builders stay specialized.
	 */
	private fun reduceToSas(preimage: ByteArray): String {
		val digest = sha256(preimage)
		var n = BigInteger.ZERO
		for (i in 0 until 8) {
			n = n.shiftLeft(8).or(BigInteger.valueOf(digest[i].toLong() and 0xFFL))
		}
		return n.mod(SAS_MODULUS).toString(10).padStart(SAS_DIGITS, '0')
	}

	// A fresh MessageDigest per call: the instance is stateful, so it must not be reused
	// across calls without reset.
	private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
}
