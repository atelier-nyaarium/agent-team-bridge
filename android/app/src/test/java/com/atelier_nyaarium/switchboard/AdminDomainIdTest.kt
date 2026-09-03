package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for adminDomainId: this device's own Domain id, derived to match
 * ChatRepository.confirmedDomainId()'s own predicate exactly. Team.gatewayId derives from its
 * canonical `name` (domain.gateway.spawn.session), so fixtures use real address-shaped names
 * rather than a settable gatewayId field. Its `.ifEmpty { localGatewayId }` normalization (kept
 * for exact parity with confirmedDomainId()) is untested here - address parsing itself rejects an
 * empty gateway segment, so a real Team can never surface one.
 */
class AdminDomainIdTest {

	private fun team(name: String, domainId: String?) = testTeam(name, status = Presence.AVAILABLE, domainId = domainId)

	@Test
	fun resolvesFromTheLocalGatewaysDomainTaggedSession() {
		val t = team("alice.gw.host.claude", domainId = "alice")
		assertEquals("alice", adminDomainId(listOf(t), homeGatewayId = "gw"))
	}

	@Test
	fun ignoresASessionFromAnotherGateway() {
		val other = team("bob.gw2.host.claude", domainId = "bob")
		assertEquals("", adminDomainId(listOf(other), homeGatewayId = "gw"))
	}

	@Test
	fun skipsALocalDomainlessEntryToFindALaterDomainTaggedOne() {
		// A domainId-less local row (e.g. a synthesized ended-thread entry) sharing the local
		// gatewayId must not mask a real local domainId reported by another row.
		val domainless = team("local.gw.old.claude", domainId = null)
		val tagged = team("alice.gw.host.claude", domainId = "alice")
		assertEquals("alice", adminDomainId(listOf(domainless, tagged), homeGatewayId = "gw"))
	}

	@Test
	fun noDomainTaggedLocalSessionYieldsEmpty() {
		val domainless = team("local.gw.host.claude", domainId = null)
		assertEquals("", adminDomainId(listOf(domainless), homeGatewayId = "gw"))
	}
}
