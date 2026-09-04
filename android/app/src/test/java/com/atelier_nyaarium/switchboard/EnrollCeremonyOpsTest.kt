package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeRef
import com.atelier_nyaarium.switchboard.proto.EnrollParty
import com.atelier_nyaarium.switchboard.proto.PendingTenantRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EnrollCeremonyOpsTest {
	@Test
	fun anInvitedRootOffersTheEnrolleeLegUntilMarkedDone() {
		val store = testStore()
		val boot = testBootstrap(store)
		store.save(
			wireJson.encodeToString(
				com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(),
				com.atelier_nyaarium.switchboard.proto.Provisioning(
					appToken = "test-token",
					device = "test-device",
					conversationId = "test-conversation",
					pendingTenant = PendingTenantRef("tenant", "invite-nonce"),
					enrollHandshake = EnrollHandshakeRef("admin-sign", "admin-box", "admin-domain", "handshake", "pin"),
				),
			),
		)
		val ops = EnrollCeremonyOps(store, TestIdentityPort(store, boot), FailingClientPort, TestEnrollCollaborators())

		val offered = ops.pendingEnrolleeCeremony() ?: error("no enrollee leg offered")
		ops.markEnrolleeCeremonyDone()

		assertEquals(EnrollCeremony.ENROLLEE, offered.role)
		assertEquals("handshake" to "pin", offered.handshakeId to offered.pin)
		assertEquals(EnrollParty(boot.ownerSignPub, boot.consoleIdentity.box.pub, "tenant"), offered.myParty)
		assertEquals(EnrollParty("admin-sign", "admin-box", "admin-domain"), offered.expectedPeer)
		assertNull(ops.pendingEnrolleeCeremony())
	}

	private class TestEnrollCollaborators : EnrollCeremonyOpsCollaborators {
		override fun enrollInvites() = mutableMapOf<String, EnrollInvite>()
		override fun ownerBoxPub() = "box"
		override fun freshEnrollSalt() = "salt"
		override fun addTrustedOwner(ownerSignPub: String) = Unit
		override suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String, edgeNonce: String) = true
	}
}
