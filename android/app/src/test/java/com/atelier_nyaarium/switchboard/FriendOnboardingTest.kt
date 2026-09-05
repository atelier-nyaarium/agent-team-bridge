package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PendingTenantRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FriendOnboardingTest {
	private fun prov(pending: PendingTenantRef?) =
		ConsoleCredentials(
			routerUrl = "https://router.example:20001",
			routerCertFp = "ab12",
			appToken = "app",
			device = "dev",
			conversationId = "conv",
			pendingTenant = pending,
			enrollHandshake = null,
			deviceApprovalReach = null,
		)

	private fun team(name: String, domainId: String?, status: String = "online", displayName: String? = null) =
		testTeam(name = name, status = status, mode = "channel", domainId = domainId, displayName = displayName)


	@Test
	fun pendingBlobRootsAtItsNonce() {
		val decision = FriendOnboarding.decide(prov(PendingTenantRef("abc123", "Tm9uY2U=")), alreadyRooted = false)
		assertTrue(decision is FirstRootDecision.Root)
		val root = decision as FirstRootDecision.Root
		assertEquals("abc123", root.domainId)
		assertEquals("Tm9uY2U=", root.nonce)
	}

	@Test
	fun ordinaryBlobIsNotPending() {
		assertTrue(FriendOnboarding.decide(prov(null), alreadyRooted = false) is FirstRootDecision.NotPending)
	}

	@Test
	fun alreadyRootedShortCircuits() {
		assertTrue(FriendOnboarding.decide(prov(PendingTenantRef("abc123", "n")), alreadyRooted = true) is FirstRootDecision.NotPending)
	}


	@Test
	fun opaqueRejectMapsToFreshCodeGuidance() {
		val msg = FriendOnboarding.humanizeFirstRootError("invalid or expired invite")
		assertTrue(msg.contains("expired or already used", ignoreCase = true))
		assertTrue(msg.contains("new one", ignoreCase = true))
	}

	@Test
	fun expiredAndClaimedAlsoMapToFreshCode() {
		assertTrue(FriendOnboarding.humanizeFirstRootError("invite expired").contains("new one", ignoreCase = true))
		assertTrue(FriendOnboarding.humanizeFirstRootError("Domain already rooted").contains("new one", ignoreCase = true))
	}

	@Test
	fun notWiredMapsToHostFinishSetup() {
		assertTrue(FriendOnboarding.humanizeFirstRootError("first-root not available").contains("finish their setup", ignoreCase = true))
		assertTrue(FriendOnboarding.humanizeFirstRootError("HTTP 501: nope").contains("finish their setup", ignoreCase = true))
	}

	@Test
	fun unknownErrorPassesThroughTrimmed() {
		val msg = FriendOnboarding.humanizeFirstRootError("some odd transport failure")
		assertTrue(msg.contains("some odd transport failure"))
	}

	@Test
	fun nullErrorHasAFallback() {
		assertTrue(FriendOnboarding.humanizeFirstRootError(null).isNotEmpty())
	}


	@Test
	fun expiredInviteIsTerminal() {
		val r = FriendOnboarding.classifyFirstRootError("invalid or expired invite")
		assertFalse(r.transient)
		assertTrue(r.message.contains("new one", ignoreCase = true))
	}

	@Test
	fun unconfiguredHostIsTerminal() {
		val r = FriendOnboarding.classifyFirstRootError("first-root not available")
		assertFalse(r.transient)
		assertTrue(r.message.contains("finish their setup", ignoreCase = true))
	}

	@Test
	fun clockSkewRejectIsTransientWithASyncHint() {
		val r = FriendOnboarding.classifyFirstRootError("admin op is stale")
		assertTrue(r.transient)
		assertTrue(r.message.contains("clock", ignoreCase = true))
	}

	@Test
	fun persistContentionIsTransientTryAgain() {
		val r = FriendOnboarding.classifyFirstRootError("persist failed: conflict")
		assertTrue(r.transient)
		assertTrue(r.message.contains("retry", ignoreCase = true) || r.message.contains("moment", ignoreCase = true))
	}

	@Test
	fun unknownRejectIsTransientAndPassesThrough() {
		val r = FriendOnboarding.classifyFirstRootError("some odd transport failure")
		assertTrue(r.transient)
		assertTrue(r.message.contains("some odd transport failure"))
	}


	@Test
	fun aGatewayPresentIsNotANoGatewayState() {
		assertEquals(NoGatewayState.NONE, FriendOnboarding.noGatewayState(noGateway = false, firstRooted = false))
		assertEquals(NoGatewayState.NONE, FriendOnboarding.noGatewayState(noGateway = false, firstRooted = true))
	}

	@Test
	fun firstRootedWithNoGatewayAwaitsAHost() {
		assertEquals(NoGatewayState.AWAITING_HOST, FriendOnboarding.noGatewayState(noGateway = true, firstRooted = true))
	}

	@Test
	fun noGatewayWithoutAFirstRootIsTheAdminCta() {
		assertEquals(NoGatewayState.NEEDS_GATEWAY, FriendOnboarding.noGatewayState(noGateway = true, firstRooted = false))
	}


	@Test
	fun renameWaitsWhileDomainUnconfirmed() {
		assertTrue(FriendOnboarding.renameAwaitsDiscovery(firstRooted = true, domainId = null))
	}

	@Test
	fun renameProceedsOnceTheDomainIsConfirmed() {
		assertFalse(FriendOnboarding.renameAwaitsDiscovery(firstRooted = true, domainId = "guest-9f3a"))
	}

	@Test
	fun notFirstRootedRenameIsNeverGated() {
		assertFalse(FriendOnboarding.renameAwaitsDiscovery(firstRooted = false, domainId = null))
	}


	@Test
	fun noSessionsIsAwaitingSetup() {
		val teams = listOf(team("local-gw/app", "alice"))
		assertEquals(HostedTenantState.AWAITING_SETUP, FriendOnboarding.hostedState("guest1", teams))
	}

	@Test
	fun aSessionThatIsOfflineReadsOffline() {
		val teams = listOf(team("guest-gw/app", "guest1", status = "available"))
		assertEquals(HostedTenantState.OFFLINE, FriendOnboarding.hostedState("guest1", teams))
	}

	@Test
	fun anOnlineSessionReadsOnline() {
		val teams = listOf(
			team("guest-gw/a", "guest1", status = "available"),
			team("guest-gw/b", "guest1", status = "online"),
		)
		assertEquals(HostedTenantState.ONLINE, FriendOnboarding.hostedState("guest1", teams))
	}


	@Test
	fun peersShowTheFriendsDisplayName() {
		val peers = CrossDomainLink.mergeLinkedDomains(
			teams = listOf(
				team("local-gw/app", "alice"),
				team("carol-gw/lib", "carol", status = "online", displayName = "Carol"),
			),
			peerOwners = mapOf("carol" to "carol-owner"),
			adminDomain = "alice",
		)
		assertEquals(1, peers.size)
		assertEquals("carol", peers[0].domainId)
		assertEquals("Carol", peers[0].displayName)
	}

	@Test
	fun peerWithNoNameYetFallsBackToNull() {
		val peers = CrossDomainLink.mergeLinkedDomains(
			teams = emptyList(),
			peerOwners = mapOf("dave" to "dave-owner"),
			adminDomain = "alice",
		)
		assertEquals(1, peers.size)
		assertNull(peers[0].displayName)
	}
}
