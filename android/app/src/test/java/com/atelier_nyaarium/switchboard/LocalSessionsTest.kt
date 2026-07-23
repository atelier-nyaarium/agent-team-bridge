package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for localSessions: the board's local/peer split, the one guard against a linked
 * friend's session double-rendering in both the flattened board and the Linked friends section.
 */
class LocalSessionsTest {

	private fun team(name: String, domainId: String?) = Team(name, "available", "", 0, domainId = domainId)

	@Test
	fun sessionsWithNoDomainIdAreLocal() {
		// The common case pre-enrollment, or a synthesized ended-thread entry.
		val t = team("local.gw.claude", domainId = null)
		assertEquals(listOf(t), localSessions(listOf(t), adminDomainId = "alice"))
	}

	@Test
	fun sessionsMatchingTheAdminDomainAreLocal() {
		val t = team("local.gw.claude", domainId = "alice")
		assertEquals(listOf(t), localSessions(listOf(t), adminDomainId = "alice"))
	}

	@Test
	fun sessionsFromAnotherDomainAreExcluded() {
		val mine = team("local.gw.claude", domainId = "alice")
		val peer = team("peer.gw.claude", domainId = "bob")
		assertEquals(listOf(mine), localSessions(listOf(mine, peer), adminDomainId = "alice"))
	}

	@Test
	fun emptyAdminDomainExcludesAnyDomainTaggedSession() {
		// The admin domain isn't resolved yet - a domain-tagged session can't be classified as
		// "mine" (it doesn't match ""), so it's excluded rather than wrongly treated as local.
		val untagged = team("local.gw.claude", domainId = null)
		val tagged = team("other.gw.claude", domainId = "bob")
		assertEquals(listOf(untagged), localSessions(listOf(untagged, tagged), adminDomainId = ""))
	}
}
