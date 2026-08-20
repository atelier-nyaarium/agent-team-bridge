package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/** The gateway-scoped presence merge: a fresh answer replaces only the rows it speaks for. */
class MergePresenceTest {

	private fun team(name: String, domainId: String? = "alice") = Team(name, "available", "", 0, domainId = domainId)

	@Test
	fun aPlaneStylePushHoldsRemoteRows() {
		// The presence plane carries the route gateway's rows only; replacing wholesale swept every
		// remote machine's rows on each local presence change.
		val prior = listOf(team("alice.sakura.host.a"), team("alice.ql-2815.host.b"))
		val fresh = listOf(team("alice.sakura.host.a2"))
		val merged = mergePresence(prior, fresh) { it.gatewayId != "sakura" }
		assertEquals(setOf("alice.sakura.host.a2", "alice.ql-2815.host.b"), merged.mapTo(HashSet()) { it.name })
	}

	@Test
	fun freshWinsOnANameCollision() {
		val prior = listOf(team("alice.ql-2815.host.b"))
		val fresh = listOf(team("alice.ql-2815.host.b", domainId = "alice"))
		val merged = mergePresence(prior, fresh) { true }
		assertEquals(1, merged.size)
	}

	@Test
	fun coverageKeysMatchBothSpellings() {
		val keys = unreachableKeys(
			com.atelier_nyaarium.switchboard.proto.DiscoverCoverage(
				rosterKnown = true,
				asked = 2,
				answered = 0,
				unreachable = listOf("ql-2815"),
				unreachablePeers = listOf("bob/lab"),
			),
		)
		assertEquals(true, rowOnUnreachable(team("alice.ql-2815.host.b"), keys, "sakura"))
		assertEquals(true, rowOnUnreachable(team("bob.lab.host.c", domainId = "bob"), keys, "sakura"))
		assertEquals(false, rowOnUnreachable(team("alice.sakura.host.a"), keys, "sakura"))
	}

	@Test
	fun noCoverageClaimsNothingToHold() {
		assertEquals(emptySet<String>(), unreachableKeys(null))
	}
}
