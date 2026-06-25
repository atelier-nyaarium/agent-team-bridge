package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the active SAS type-to-match gate: the security rule is "Confirm unlocks ONLY on an
 * exact local match", so a wrong, short, or empty typed code must NOT match while the exact
 * code (with or without the grouping a human reads aloud) must.
 */
class CrossDomainLinkTest {
	private val sas = "847291" // a 6-digit code, the width SasCrypto emits

	@Test
	fun exactMatchUnlocks() {
		assertTrue(CrossDomainLink.sasMatches(sas, "847291"))
	}

	@Test
	fun groupingWhitespaceIsIgnored() {
		// The human reads "847 291"; the typed grouping must not defeat the compare.
		assertTrue(CrossDomainLink.sasMatches(sas, "847 291"))
		assertTrue(CrossDomainLink.sasMatches(sas, " 847-291 "))
	}

	@Test
	fun wrongDigitsDoNotMatch() {
		assertFalse(CrossDomainLink.sasMatches(sas, "847292"))
		assertFalse(CrossDomainLink.sasMatches(sas, "999999"))
	}

	@Test
	fun partialOrEmptyNeverMatches() {
		assertFalse(CrossDomainLink.sasMatches(sas, ""))
		assertFalse(CrossDomainLink.sasMatches(sas, "847"))
		assertFalse(CrossDomainLink.sasMatches(sas, "84729")) // 5 digits
		// A correct prefix plus extra digits is the wrong length, so it must not match.
		assertFalse(CrossDomainLink.sasMatches(sas, "8472910"))
	}

	@Test
	fun normalizeKeepsOnlyDigits() {
		assertEquals("847291", CrossDomainLink.normalizeTypedSas(" 847-291 "))
		assertEquals("", CrossDomainLink.normalizeTypedSas("abc -- "))
	}

	// -- The PEERS roster union (Fix: a freshly-linked peer is otherwise invisible) --

	private fun team(name: String, domainId: String?, status: String = "online") =
		Team(name = name, status = status, mode = "channel", queueDepth = 0, domainId = domainId)

	@Test
	fun mergeListsALinkedButOfflinePeerWithNoDiscoverySessions() {
		// The core fix: "bob" is in the gateway's peer set but has no discovery session (its gateway
		// is offline / shared nothing back). It MUST still appear so PeerDetail is reachable.
		val peers = CrossDomainLink.mergeLinkedDomains(
			teams = listOf(team("home-gw/app", "alice")),
			peerOwners = mapOf("bob" to "bob-owner"),
			home = "alice",
		)
		assertEquals(1, peers.size)
		assertEquals("bob", peers[0].domainId)
		assertEquals(0, peers[0].sessionCount)
		assertFalse("a peer present only in the peer set must read offline", peers[0].online)
	}

	@Test
	fun mergeUnionsPeerSetWithDiscoveryAndDedupes() {
		// "carol" appears in BOTH discovery (one online session) and the peer set; it must collapse
		// to one row carrying discovery's count + presence. "dave" is peer-set-only (offline).
		val peers = CrossDomainLink.mergeLinkedDomains(
			teams = listOf(
				team("home-gw/app", "alice"),
				team("carol-gw/lib", "carol", status = "online"),
			),
			peerOwners = mapOf("carol" to "carol-owner", "dave" to "dave-owner"),
			home = "alice",
		)
		assertEquals(listOf("carol", "dave"), peers.map { it.domainId }) // sorted, no dupes
		val carol = peers.first { it.domainId == "carol" }
		assertEquals(1, carol.sessionCount)
		assertTrue(carol.online)
		val dave = peers.first { it.domainId == "dave" }
		assertEquals(0, dave.sessionCount)
		assertFalse(dave.online)
	}

	@Test
	fun mergeExcludesHomeFromBothInputs() {
		// A home-tagged session and the home Domain id in the peer set must never list as a peer.
		val peers = CrossDomainLink.mergeLinkedDomains(
			teams = listOf(team("home-gw/app", "alice"), team("home-gw/api", null)),
			peerOwners = mapOf("alice" to "home-owner"),
			home = "alice",
		)
		assertTrue("home is never a peer", peers.isEmpty())
	}

	@Test
	fun mergeFallsBackToDiscoveryWhenPeerSetEmpty() {
		// An empty peer set (relay roster unavailable) must not blank a peer discovery already found.
		val peers = CrossDomainLink.mergeLinkedDomains(
			teams = listOf(team("erin-gw/svc", "erin", status = "online")),
			peerOwners = emptyMap(),
			home = "alice",
		)
		assertEquals(listOf("erin"), peers.map { it.domainId })
		assertTrue(peers[0].online)
	}

	// -- The edge-retry outcome (Fix: a failed relay-affinity edge submit must not show "Linked") --

	@Test
	fun relayEdgeRejectedCarriesThePeerDomainForRetry() {
		// The wizard maps RelayEdgeRejected -> LinkStep.LinkedNoRelay(peerDomainId) so Retry can
		// re-submit ONLY that edge (no unlink+relink). Pin the carried Domain.
		val outcome: ConfirmOutcome = ConfirmOutcome.RelayEdgeRejected("bob")
		assertTrue(outcome is ConfirmOutcome.RelayEdgeRejected)
		assertEquals("bob", (outcome as ConfirmOutcome.RelayEdgeRejected).peerDomainId)
	}

	@Test
	fun confirmOutcomesAreDistinct() {
		// Linked and RelayEdgeRejected must be different states so the wizard never renders a false
		// "Linked" for a rejected relay edge.
		assertFalse(ConfirmOutcome.Linked == ConfirmOutcome.RelayEdgeRejected("bob"))
		assertEquals(ConfirmOutcome.RelayEdgeRejected("bob"), ConfirmOutcome.RelayEdgeRejected("bob"))
	}
}
