package com.atelier_nyaarium.switchboard.proto

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

/**
 * Cross-Domain pairing SAS + commitment (commit-reveal SAS-AKE).
 *
 * Hand-authored twin of src/shared/cross-domain-sas.ts, kept equivalent by the
 * shared vectors in tests/fixtures/cross-domain-sas/vectors.json (read by both
 * runtimes), exactly as SessionId.kt is pinned by the session-id vectors. See the
 * TS file for the design rationale.
 *
 * The cross-Domain listening-mode handshake is an unauthenticated key exchange
 * between two owners' Gateways relayed by the content-blind Router. A bare SAS over
 * only the public keys + the pin is offline grindable, so each side first publishes
 * a hiding commitment to its own keys+ids; the SAS then binds the committed keys +
 * both sides' ids + the pin. Because this twin must reproduce the TS values
 * byte-for-byte, the derivation uses ONLY SHA-256 + big-endian BigInteger math (no
 * language-specific quirks).
 */

////////////////////////////////
//  Interfaces & Types

/**
 * One side's committed identity: the keys + ids the side binds into the link and the
 * SAS. Both the commitment and the SAS are computed over these fields in this exact
 * order, so the two runtimes must assemble them identically.
 */
data class CrossDomainParty(
	val ownerSignPub: String,
	val gatewaySignPub: String,
	val gatewayBoxPub: String,
	val domainId: String,
	val gatewayId: String,
)

////////////////////////////////
//  Class

object SasCrypto {
	// The displayed safety code is this many decimal digits, shown as two groups of three.
	// The code is a yes/no COMPARE, so its ceiling is human rubber-stamping (which rises with
	// length), not the crypto residual: six digits keeps the post-commitment online-guess space
	// negligible (1-in-10^6) while staying easy to compare faithfully.
	private const val SAS_DIGITS = 6

	// 10^6 (computed from SAS_DIGITS), the modulus the digest reduces to. A BigInteger because
	// the digest value `n` it reduces is a BigInteger (the 8 digest bytes reach ~1.8e19).
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
	 * A side's hiding commitment to its own keys+ids: SHA-256 of the canonical
	 * commitment preimage, base64. The peer re-derives it from the revealed
	 * keys+ids+salt and aborts the handshake on a mismatch.
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
	 * The canonical SAS preimage: the literal `SAS_V1`, then BOTH sides' five identity
	 * fields SORTED lexicographically by their string value, then the pin - all
	 * newline-joined, UTF-8.
	 *
	 * The fields are sorted as a flat list so the result is order-independent: each side
	 * holds the same ten identity fields (its own five + the peer's five) and sorts them
	 * to the same sequence regardless of which side it is.
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

	/**
	 * The displayed safety code: SHA-256 the canonical preimage, read the FIRST 8 digest
	 * bytes as a big-endian unsigned integer, reduce mod 10^6, and zero-pad to 6
	 * decimal digits (displayed as two groups of three).
	 *
	 *   1. preimage = crossDomainSasPreimage(a, b, pin)   (UTF-8 bytes)
	 *   2. digest   = SHA-256(preimage)                   (32 bytes)
	 *   3. n        = digest[0..7] as a big-endian unsigned integer
	 *   4. code     = (n mod 10^6) zero-padded to 6 digits
	 */
	fun crossDomainSas(a: CrossDomainParty, b: CrossDomainParty, pin: String): String {
		val digest = sha256(crossDomainSasPreimage(a, b, pin))
		var n = BigInteger.ZERO
		for (i in 0 until 8) {
			n = n.shiftLeft(8).or(BigInteger.valueOf(digest[i].toLong() and 0xFFL))
		}
		return n.mod(SAS_MODULUS).toString(10).padStart(SAS_DIGITS, '0')
	}

	////////////////////////////////
	//  Functions & Helpers

	// A fresh MessageDigest per call: the instance is stateful, so it must not be reused
	// across calls without reset.
	private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
}
