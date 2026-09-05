package com.atelier_nyaarium.switchboard.proto

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

// Hand-authored twin of cross-domain-sas.ts; fixture vectors require byte equality.
data class CrossDomainParty(
	val ownerSignPub: String,
	val gatewaySignPub: String,
	val gatewayBoxPub: String,
	val domainId: String,
	val gatewayId: String,
)

data class EnrollParty(
	val ownerSignPub: String,
	val ownerBoxPub: String,
	val domainId: String,
)

object SasCrypto {
	// Six digits keep post-commitment online guesses at one in a million.
	private const val SAS_DIGITS = 6

	// BigInteger preserves all eight digest bytes before reduction.
	private val SAS_MODULUS: BigInteger = BigInteger.TEN.pow(SAS_DIGITS)

	// Commitment fields use fixed order and UTF-8 newline joining.
	fun crossDomainCommitmentPreimage(party: CrossDomainParty, salt: String): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_SAS_COMMIT,
			party.ownerSignPub,
			party.gatewaySignPub,
			party.gatewayBoxPub,
			party.domainId,
			party.gatewayId,
			salt,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun crossDomainCommitment(party: CrossDomainParty, salt: String): String =
		Base64.getEncoder().encodeToString(sha256(crossDomainCommitmentPreimage(party, salt)))

	fun verifyCrossDomainCommitment(commitment: String, party: CrossDomainParty, salt: String): Boolean =
		crossDomainCommitment(party, salt) == commitment

	fun crossDomainSasPreimage(a: CrossDomainParty, b: CrossDomainParty, pin: String): ByteArray {
		// Flat sorting makes the SAS independent of side order.
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
		return (listOf(Protocol.Wire.SIGNING_TAG_SAS) + fields + listOf(pin)).joinToString("\n").toByteArray(Charsets.UTF_8)
	}

	fun crossDomainSas(a: CrossDomainParty, b: CrossDomainParty, pin: String): String =
		reduceToSas(crossDomainSasPreimage(a, b, pin))

	// Role tags occupy fixed slots so the Router cannot transpose enrollment sides.
	fun enrollCommitmentPreimage(party: EnrollParty, role: String, salt: String): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_ENROLL_COMMIT,
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
			Protocol.Wire.SIGNING_TAG_ENROLL_SAS,
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

	private fun reduceToSas(preimage: ByteArray): String {
		val digest = sha256(preimage)
		var n = BigInteger.ZERO
		for (i in 0 until 8) {
			n = n.shiftLeft(8).or(BigInteger.valueOf(digest[i].toLong() and 0xFFL))
		}
		return n.mod(SAS_MODULUS).toString(10).padStart(SAS_DIGITS, '0')
	}

	private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
}
