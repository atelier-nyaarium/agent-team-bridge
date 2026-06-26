package com.atelier_nyaarium.switchboard

import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Locks EnrollPinning.checkPinnedLeaf: accept ONLY the exact pinned leaf, reject any other
 * fingerprint or an empty chain, and match (case-insensitively) the lowercase-hex SHA-256 the gateway
 * computes. The cert below is a throwaway self-signed EC leaf (openssl, SAN=IP:192.168.1.5).
 */
class LeafFingerprintPinTest {
	private val certDerB64 =
		"MIIBqTCCAVCgAwIBAgIUQDgxk2W6KEwDZJfkZvkdOKlyKmgwCgYIKoZIzj0EAwIwIjEgMB4GA1UEAwwXc3dpdGNoYm9hcmQtZW5yb2xsLXRlc3QwHhcNMjYwNjI2MjEzNTQ0WhcNMjYwNjI3MjEzNTQ0WjAiMSAwHgYDVQQDDBdzd2l0Y2hib2FyZC1lbnJvbGwtdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABIToIQ2RAqlLJh2SXWFHaUizr8/F7VUZeihSG7IjvANLeBENT3ruXfzOVFWZN5ORpALkjNF4TlxE3/Qh28pp7gSjZDBiMB0GA1UdDgQWBBShhC0SlzqpRh6DIQ4p6Ltb38yNETAfBgNVHSMEGDAWgBShhC0SlzqpRh6DIQ4p6Ltb38yNETAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBMCoAQUwCgYIKoZIzj0EAwIDRwAwRAIgVQy1vI+sCeSqOCYSocEeEHg5tZVdtEc+4GQkg/X+z6kCIDxWDwmzVEDEH1vm+smMTja+G+rLEPly1/qhuUyLwI8C"
	private val certFp = "e76c56addde760dea05ff34f353df9123035105342fb6d958643942634437b1c"

	private fun cert(): X509Certificate =
		CertificateFactory.getInstance("X.509")
			.generateCertificate(ByteArrayInputStream(Base64.getDecoder().decode(certDerB64))) as X509Certificate

	@Test
	fun matchesTheGatewayHexFingerprint() {
		val fp = MessageDigest.getInstance("SHA-256").digest(cert().encoded).joinToString("") { "%02x".format(it) }
		assertEquals(certFp, fp)
	}

	@Test
	fun acceptsTheMatchingLeaf() {
		checkPinnedLeaf(arrayOf(cert()), certFp)
	}

	@Test
	fun acceptsRegardlessOfHexCase() {
		checkPinnedLeaf(arrayOf(cert()), certFp.uppercase())
	}

	@Test
	fun rejectsAMismatchedFingerprint() {
		assertThrows(CertificateException::class.java) { checkPinnedLeaf(arrayOf(cert()), "00".repeat(32)) }
	}

	@Test
	fun rejectsAnEmptyChain() {
		assertThrows(CertificateException::class.java) { checkPinnedLeaf(emptyArray(), certFp) }
	}
}
