package com.atelier_nyaarium.switchboard

import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the TLS-failure split in classifyConnError: "certificate changed" (terminal) is reserved
 * for actual validation evidence in the cause chain, while a handshake merely dropped mid-flight
 * (a reset, a degraded control plane) classifies transient so the app retries instead of telling
 * the user to re-run setup. A bare SSLHandshakeException with no validation evidence in its cause
 * chain must classify as transient even when the underlying cause is a control-plane outage rather
 * than a client-side network blip.
 */
class ClassifyConnErrorTest {

	@Test
	fun bareHandshakeFailureIsTransientNotCertChange() {
		val (msg, kind) = classifyConnError(SSLHandshakeException("Handshake failed"))
		assertEquals(ConnKind.TRANSIENT, kind)
		assertEquals("Secure connection interrupted - retrying", msg)
	}

	@Test
	fun validationEvidenceStaysTerminal() {
		// The Android wrapping shape: SSLHandshakeException -> CertificateException -> CertPathValidatorException.
		val wrapped = SSLHandshakeException("Handshake failed").apply {
			initCause(CertificateException(CertPathValidatorException("Trust anchor for certification path not found")))
		}
		val (msg, kind) = classifyConnError(wrapped)
		assertEquals(ConnKind.TERMINAL, kind)
		assertEquals("Server certificate changed - re-run setup.sh", msg)
		// A directly-thrown CertificateException (the enroll pinned-leaf mismatch) is terminal too.
		val (_, direct) = classifyConnError(CertificateException("enroll cert fingerprint mismatch"))
		assertEquals(ConnKind.TERMINAL, direct)
	}
}
