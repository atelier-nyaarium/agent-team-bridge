package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceSession
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for dedupedFriendSessions: the guard against a linked (but only cryptographically,
 * not content, trusted) friend's Gateway reporting two sessions sharing one (gatewayId, team) pair,
 * which would otherwise crash the "Linked friends" LazyColumn's duplicate-key check.
 */
class DedupedFriendSessionsTest {

	private fun session(gatewayId: String, team: String, sessionLabel: String? = null) =
		CrossDomainPresenceSession(team = team, gatewayId = gatewayId, status = "online", kind = "loose", sessionLabel = sessionLabel, queueDepth = 0)

	@Test
	fun distinctPairsAllSurvive() {
		val a = session("gw1", "alice")
		val b = session("gw1", "bob")
		val c = session("gw2", "alice")
		assertEquals(listOf(a, b, c), dedupedFriendSessions(listOf(a, b, c)))
	}

	@Test
	fun aRepeatedGatewayIdTeamPairIsDroppedKeepingTheFirst() {
		val first = session("gw1", "alice", sessionLabel = "First")
		val duplicate = session("gw1", "alice", sessionLabel = "Second")
		assertEquals(listOf(first), dedupedFriendSessions(listOf(first, duplicate)))
	}

	@Test
	fun sameTeamOnDifferentGatewaysIsNotADuplicate() {
		val a = session("gw1", "alice")
		val b = session("gw2", "alice")
		assertEquals(listOf(a, b), dedupedFriendSessions(listOf(a, b)))
	}

	@Test
	fun emptyListStaysEmpty() {
		assertEquals(emptyList<CrossDomainPresenceSession>(), dedupedFriendSessions(emptyList()))
	}
}
