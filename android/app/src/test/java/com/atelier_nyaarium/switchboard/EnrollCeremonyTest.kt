package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollParty
import com.atelier_nyaarium.switchboard.proto.EnrollReveal
import com.atelier_nyaarium.switchboard.proto.SasCrypto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the pure decisions of the FLOW-1 enroll ceremony: the two roles derive the SAME compare code
 * (so a glance compare is meaningful), the role ordering is fixed (an ADMIN/ENROLLEE swap changes
 * the code, matching the role-tagged preimage), and the commit-reveal binding rejects a tampered
 * peer reveal. The networked orchestration is exercised on-device; these are the security-critical
 * local checks an untrusted broker cannot influence.
 */
class EnrollCeremonyTest {
	private val admin = EnrollParty(ownerSignPub = "adminSign", ownerBoxPub = "adminBox", domainId = "home")
	private val enrollee = EnrollParty(ownerSignPub = "userSign", ownerBoxPub = "userBox", domainId = "guest42")
	private val pin = "pin-abc"

	@Test
	fun peerRolePairs() {
		assertEquals(EnrollCeremony.ENROLLEE, EnrollCeremony.peerRole(EnrollCeremony.ADMIN))
		assertEquals(EnrollCeremony.ADMIN, EnrollCeremony.peerRole(EnrollCeremony.ENROLLEE))
	}

	@Test
	fun bothRolesComputeTheSameCompareCode() {
		// The admin holds (myParty=admin, peer=enrollee); the enrollee holds (myParty=enrollee,
		// peer=admin). Both must produce the identical 6-digit code, or the glance compare is broken.
		val adminCode = EnrollCeremony.sas(EnrollCeremony.ADMIN, admin, enrollee, pin)
		val enrolleeCode = EnrollCeremony.sas(EnrollCeremony.ENROLLEE, enrollee, admin, pin)
		assertEquals(adminCode, enrolleeCode)
		// And it is exactly the canonical ADMIN-block-then-ENROLLEE-block derivation.
		assertEquals(SasCrypto.enrollSas(admin, enrollee, pin), adminCode)
		assertEquals(6, adminCode.length)
	}

	@Test
	fun roleOrderingIsNotSymmetric() {
		// The preimage is role-tagged (fixed ADMIN/ENROLLEE slots), so swapping who is admin must
		// change the code - otherwise a relay could transpose the two blocks undetected.
		val correct = EnrollCeremony.sas(EnrollCeremony.ADMIN, admin, enrollee, pin)
		val swapped = SasCrypto.enrollSas(enrollee, admin, pin)
		assertNotEquals(correct, swapped)
	}

	@Test
	fun pinBindsTheCode() {
		val a = EnrollCeremony.sas(EnrollCeremony.ADMIN, admin, enrollee, pin)
		val b = EnrollCeremony.sas(EnrollCeremony.ADMIN, admin, enrollee, "pin-xyz")
		assertNotEquals(a, b)
	}

	@Test
	fun partyOfReadsTheRevealKeysAndDomain() {
		val reveal = EnrollReveal(ownerSignPub = "userSign", ownerBoxPub = "userBox", domainId = "guest42", salt = "s")
		assertEquals(enrollee, EnrollCeremony.partyOf(reveal))
	}

	@Test
	fun verifyPeerAcceptsAMatchingCommitReveal() {
		val salt = "salt-1"
		val commitment = SasCrypto.enrollCommitment(enrollee, EnrollCeremony.ENROLLEE, salt)
		assertTrue(EnrollCeremony.verifyPeer(commitment, enrollee, EnrollCeremony.ENROLLEE, salt))
	}

	@Test
	fun verifyPeerRejectsTampering() {
		val salt = "salt-1"
		val commitment = SasCrypto.enrollCommitment(enrollee, EnrollCeremony.ENROLLEE, salt)
		// A swapped key in the reveal (evie substitution) no longer opens the commitment.
		val swappedKey = enrollee.copy(ownerSignPub = "attackerSign")
		assertFalse(EnrollCeremony.verifyPeer(commitment, swappedKey, EnrollCeremony.ENROLLEE, salt))
		// A wrong salt fails too.
		assertFalse(EnrollCeremony.verifyPeer(commitment, enrollee, EnrollCeremony.ENROLLEE, "salt-2"))
		// And a role mismatch (the binding is role-tagged) fails.
		assertFalse(EnrollCeremony.verifyPeer(commitment, enrollee, EnrollCeremony.ADMIN, salt))
	}
}
