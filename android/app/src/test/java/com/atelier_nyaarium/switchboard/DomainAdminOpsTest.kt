package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class DomainAdminOpsTest {
	@Test
	fun inviteBlobMintsOneHandshakePerTenant() = runBlocking {
		val store = testStore()
		val boot = testBootstrap(store, domainId = "admin-domain")
		val collaborators = TestDomainCollaborators()
		val ops = DomainAdminOps(MutableStateFlow(ChatState()), store, TestIdentityPort(store, boot), FailingClientPort, collaborators)
		val tenant = HostedTenant("tenant", "Friend", "invite-nonce", HostedTenantState.AWAITING_SETUP)

		val first = JSONObject(ops.buildInviteBlob(tenant).getOrThrow())
		val second = JSONObject(ops.buildInviteBlob(tenant).getOrThrow())
		val other = JSONObject(ops.buildInviteBlob(tenant.copy(domainId = "other")).getOrThrow())

		assertEquals(first.toString(), second.toString())
		assertEquals("pin-1", first.getJSONObject("enrollHandshake").getString("pin"))
		assertEquals("pin-2", other.getJSONObject("enrollHandshake").getString("pin"))
		assertEquals("admin-domain", first.getJSONObject("enrollHandshake").getString("adminDomainId"))
		assertEquals(boot.ownerSignPub, first.getJSONObject("enrollHandshake").getString("adminOwnerSignPub"))
		assertEquals("invite-nonce", first.getJSONObject("pendingTenant").getString("nonce"))
		assertEquals("test-token", first.getString("appToken"))
	}

	private class TestDomainCollaborators : DomainAdminOpsCollaborators {
		private val invites = mutableMapOf<String, EnrollInvite>()
		private var minted = 0
		override fun enrollInvites() = invites
		override fun ownerBoxPub() = "box"
		override fun freshHandshakeId() = "handshake-${invites.size + 1}"
		override fun freshEnrollPin() = "pin-${++minted}"
		override fun newDomainId() = "domain"
		override fun signSetDisplayName(domainId: String, name: String, nowMs: Long) = error("unused")
		override fun signDeleteDomain(domainId: String, nowMs: Long) = error("unused")
		override fun signProvisionTenant(domainId: String, name: String, nowMs: Long) = error("unused")
		override fun signRemoveTenant(domainId: String, nowMs: Long) = error("unused")
		override suspend fun clearAll() = Unit
	}
}
