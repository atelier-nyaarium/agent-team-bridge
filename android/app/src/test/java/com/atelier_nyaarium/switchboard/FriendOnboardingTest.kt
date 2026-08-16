package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PendingTenantRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the pure friend-onboarding decision logic (the first-root branch, the reject humanization,
 * and the hosted-tenant state machine). The crypto/signing-bytes are pinned separately by
 * ProvisionOpsTest's cross-runtime vectors; this covers the app-side glue around them.
 */
class FriendOnboardingTest {
	private fun prov(pending: PendingTenantRef?) =
		Provisioning(
			apiUrl = "https://api",
			caPem = "ca",
			saToken = "sa",
			appToken = "app",
			namespace = "evie-bot",
			service = "evie-console-bridge",
			port = 20004,
			device = "dev",
			conversationId = "conv",
			pendingTenant = pending,
		)

	private fun team(name: String, domainId: String?, status: String = "online", displayName: String? = null) =
		Team(name = name, status = status, mode = "channel", queueDepth = 0, domainId = domainId, displayName = displayName)

	// -- The first-root decision (blob pendingTenant branch) --

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
		// No pendingTenant: an already-rooted admin blob just provisions the console.
		assertTrue(FriendOnboarding.decide(prov(null), alreadyRooted = false) is FirstRootDecision.NotPending)
	}

	@Test
	fun alreadyRootedShortCircuits() {
		// A reconnect after a successful root must NOT re-POST first_root, even with the blob still
		// carrying the (now spent) pendingTenant.
		assertTrue(FriendOnboarding.decide(prov(PendingTenantRef("abc123", "n")), alreadyRooted = true) is FirstRootDecision.NotPending)
	}

	// -- The reject humanization (UX error states) --

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

	// -- The transient-vs-terminal first-root classification (auto-retry vs dead end) --

	@Test
	fun expiredInviteIsTerminal() {
		// The root was decided (used/expired nonce): waiting will not help, so it is terminal.
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
		// The Router's "admin op is stale" is a >2min device clock skew; the latch stays false and the
		// poll loop re-attempts, so it must classify transient (auto-retry) with a clock-sync hint.
		val r = FriendOnboarding.classifyFirstRootError("admin op is stale")
		assertTrue(r.transient)
		assertTrue(r.message.contains("clock", ignoreCase = true))
	}

	@Test
	fun persistContentionIsTransientTryAgain() {
		// A CAS persist contention at the Router is momentary; classify transient so the UI reflects the
		// auto-retry rather than a hard failure.
		val r = FriendOnboarding.classifyFirstRootError("persist failed: conflict")
		assertTrue(r.transient)
		assertTrue(r.message.contains("retry", ignoreCase = true) || r.message.contains("moment", ignoreCase = true))
	}

	@Test
	fun unknownRejectIsTransientAndPassesThrough() {
		// An unrecognized cause may clear on the next attempt (fresh timestamp + nonce), so it is
		// transient and carries the original text for diagnosis.
		val r = FriendOnboarding.classifyFirstRootError("some odd transport failure")
		assertTrue(r.transient)
		assertTrue(r.message.contains("some odd transport failure"))
	}

	// -- The no-gateway empty-board split (friend awaiting host vs admin add-a-gateway) --

	@Test
	fun aGatewayPresentIsNotANoGatewayState() {
		// No no-gateway error: the board is connecting/connected, not in either onboarding branch.
		assertEquals(NoGatewayState.NONE, FriendOnboarding.noGatewayState(noGateway = false, firstRooted = false))
		assertEquals(NoGatewayState.NONE, FriendOnboarding.noGatewayState(noGateway = false, firstRooted = true))
	}

	@Test
	fun firstRootedWithNoGatewayAwaitsAHost() {
		// A friend who just first-rooted has no host yet: point at the Setting-up-a-host manual.
		assertEquals(NoGatewayState.AWAITING_HOST, FriendOnboarding.noGatewayState(noGateway = true, firstRooted = true))
	}

	@Test
	fun noGatewayWithoutAFirstRootIsTheAdminCta() {
		// An admin who never first-rooted just needs to admit a Gateway.
		assertEquals(NoGatewayState.NEEDS_GATEWAY, FriendOnboarding.noGatewayState(noGateway = true, firstRooted = false))
	}

	// -- The rename-before-discovery gate (Domain not yet confirmed) --

	@Test
	fun renameWaitsWhileDomainUnconfirmed() {
		// A device that first-rooted its own Domain but has no confirmed local session yet (null) cannot
		// sign a rename over a real Domain, so Save is gated.
		assertTrue(FriendOnboarding.renameAwaitsDiscovery(firstRooted = true, confirmedDomainId = null))
	}

	@Test
	fun renameProceedsOnceTheDomainIsConfirmed() {
		assertFalse(FriendOnboarding.renameAwaitsDiscovery(firstRooted = true, confirmedDomainId = "guest-9f3a"))
	}

	@Test
	fun notFirstRootedRenameIsNeverGated() {
		// A device that never first-rooted is not gated even before a Domain is confirmed.
		assertFalse(FriendOnboarding.renameAwaitsDiscovery(firstRooted = false, confirmedDomainId = null))
	}

	// -- The hosted-tenant state machine (awaiting -> offline -> online) --

	@Test
	fun noSessionsIsAwaitingSetup() {
		// The friend has not first-rooted + brought a gateway online yet: nothing in discovery.
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

	// -- The propagated display name in the Peers list --

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
		// A peer present only in the peer set (no discovery session) has no displayName yet; the UI
		// falls back to the opaque domainId.
		val peers = CrossDomainLink.mergeLinkedDomains(
			teams = emptyList(),
			peerOwners = mapOf("dave" to "dave-owner"),
			adminDomain = "alice",
		)
		assertEquals(1, peers.size)
		assertNull(peers[0].displayName)
	}
}
