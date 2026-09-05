package com.atelier_nyaarium.switchboard

import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException
import org.junit.Assert.assertEquals
import org.junit.Test

/** Terminal needs validation evidence. */
class ClassifyConnErrorTest {

	@Test
	fun bareHandshakeFailureIsTransientNotCertChange() {
		val (_, kind) = classifyConnError(SSLHandshakeException("Handshake failed"))
		assertEquals(ConnKind.TRANSIENT, kind)
	}

	@Test
	fun validationEvidenceStaysTerminal() {
		// The Android wrapping shape.
		val wrapped = SSLHandshakeException("Handshake failed").apply {
			initCause(CertificateException(CertPathValidatorException("Trust anchor for certification path not found")))
		}
		val (_, kind) = classifyConnError(wrapped)
		assertEquals(ConnKind.TERMINAL, kind)
		val (_, direct) = classifyConnError(CertificateException("enroll cert fingerprint mismatch"))
		assertEquals(ConnKind.TERMINAL, direct)
	}
}
