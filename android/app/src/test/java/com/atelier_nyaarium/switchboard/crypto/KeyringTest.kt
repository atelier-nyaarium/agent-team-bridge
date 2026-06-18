package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.Revocation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The device-side trust rule: the Console resolves a Switch only through an
 * owner-signed, non-revoked admission. A forged admission (signed by anyone but the
 * pinned owner) and a revoked one both fail to resolve, so a compromised relay can
 * never hand the Console a Switch key it did not owner-admit.
 */
class KeyringTest {
	private val owner = Crypto.generateIdentity()
	private val switchA = Crypto.generateIdentity()

	private fun admit(id: Crypto.Identity, switchId: String, issuedAt: Long, ownerKey: Crypto.Identity = owner) =
		AdmissionCrypto.signAdmission(
			Admission("switch", id.sign.pub, id.box.pub, switchId, issuedAt, "n-$issuedAt"),
			ownerKey.sign.priv,
			ownerKey.sign.pub,
		)

	@Test
	fun resolvesAnOwnerAdmittedSwitch() {
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admit(switchA, "sakura", 1000L)), emptyList()))
		val resolved = keyring.resolveSwitch("sakura")
		assertEquals(switchA.box.pub, resolved?.boxPub)
		assertEquals(switchA.sign.pub, resolved?.signPub)
	}

	@Test
	fun rejectsAForgedAdmission() {
		// Signed by an attacker key, not the pinned owner: must not resolve.
		val attacker = Crypto.generateIdentity()
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admit(switchA, "sakura", 1000L, attacker)), emptyList()))
		assertNull(keyring.resolveSwitch("sakura"))
	}

	@Test
	fun rejectsARevokedSwitch() {
		val revocation = AdmissionCrypto.signRevocation(
			Revocation(switchA.sign.pub, 2000L, "rev"),
			owner.sign.priv,
			owner.sign.pub,
		)
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admit(switchA, "sakura", 1000L)), listOf(revocation)))
		assertNull(keyring.resolveSwitch("sakura"))
	}

	@Test
	fun newestAdmissionWins() {
		val rotated = Crypto.generateIdentity()
		val keyring = Keyring(
			DomainSnapshot(
				owner.sign.pub,
				listOf(admit(switchA, "sakura", 1000L), admit(rotated, "sakura", 3000L)),
				emptyList(),
			),
		)
		assertEquals(rotated.box.pub, keyring.resolveSwitch("sakura")?.boxPub)
	}
}
