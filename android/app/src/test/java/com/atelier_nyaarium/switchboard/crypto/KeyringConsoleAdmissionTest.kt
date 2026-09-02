package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.Revocation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class KeyringConsoleAdmissionTest {
	private val owner = Crypto.generateIdentity()
	private val console = Crypto.generateIdentity()

	private fun admit(kind: String, issuedAt: Long) = AdmissionCrypto.signAdmission(
		Admission(kind, console.sign.pub, console.box.pub, null, issuedAt, "n-$issuedAt"),
		owner.sign.priv,
		owner.sign.pub,
	)

	@Test
	fun returnsNewestConsoleAdmission() {
		val snapshot = DomainSnapshot(owner.sign.pub, listOf(admit("console", 1), admit("console", 2)), emptyList())
		assertEquals(2L, Keyring(snapshot).signedConsoleAdmission(console.sign.pub)?.admission?.issuedAt)
	}

	@Test
	fun returnsNullWhenNewestAdmissionIsGateway() {
		val snapshot = DomainSnapshot(owner.sign.pub, listOf(admit("console", 1), admit("gateway", 2)), emptyList())
		assertNull(Keyring(snapshot).signedConsoleAdmission(console.sign.pub))
	}

	@Test
	fun returnsNullWhenNewestAdmissionIsRevoked() {
		val revocation = AdmissionCrypto.signRevocation(
			Revocation(console.sign.pub, 3, "rev"),
			owner.sign.priv,
			owner.sign.pub,
		)
		val snapshot = DomainSnapshot(owner.sign.pub, listOf(admit("console", 2)), listOf(revocation))
		assertNull(Keyring(snapshot).signedConsoleAdmission(console.sign.pub))
	}
}
