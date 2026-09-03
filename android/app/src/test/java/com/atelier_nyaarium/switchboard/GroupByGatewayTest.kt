package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the sessions board's machine list: which Gateways get a section, and what a picked
 * project resolves to once one is pressed.
 */
class GroupByGatewayTest {

	// gatewayId derives from the qualified name, so the fixtures spell it there.
	private fun team(name: String, domainId: String? = "alice") = testTeam(name, status = Presence.AVAILABLE, domainId = domainId)

	private fun keys(groups: List<Pair<GatewayGroupKey, List<Team>>>) = groups.map { it.first.gatewayId }

	@Test
	fun anAdmittedGatewayWithNoSessionsStillGetsASection() {
		// The reported bug: a second machine registers, relays, and draws nothing, because the roster
		// it contributes to is built from session rows and it has none.
		val rows = listOf(team("alice.sakura.claude"))
		val groups = groupByGateway(rows, listOf("sakura", "ql-2815"), adminDomainId = "alice", homeGatewayId = "sakura")
		assertEquals(listOf("sakura", "ql-2815"), keys(groups))
		assertEquals(emptyList<Team>(), groups.last().second)
	}

	@Test
	fun anAdmittedGatewayWithSessionsIsNotDrawnTwice() {
		val rows = listOf(team("alice.ql-2815.claude"))
		val groups = groupByGateway(rows, listOf("sakura", "ql-2815"), adminDomainId = "alice", homeGatewayId = "sakura")
		assertEquals(1, groups.count { it.first.gatewayId == "ql-2815" })
		assertEquals(rows, groups.first { it.first.gatewayId == "ql-2815" }.second)
	}

	@Test
	fun theRouteGatewaySortsFirst() {
		val rows = listOf(team("alice.aaa.claude"), team("alice.sakura.claude"))
		val groups = groupByGateway(rows, listOf("zzz"), adminDomainId = "alice", homeGatewayId = "sakura")
		assertEquals("sakura", keys(groups).first())
	}

	@Test
	fun beforeTheDomainIsKnownOnlyTheRouteGatewayIsNamed() {
		// A machine can only be named through its Domain, and nothing here acts on a guessed one. The
		// route Gateway needs none, since a bare target already names it.
		val rows = listOf(team("local.sakura.claude", domainId = null))
		val groups = groupByGateway(rows, listOf("sakura", "ql-2815"), adminDomainId = "", homeGatewayId = "sakura")
		assertEquals(listOf("sakura"), keys(groups))
	}

	@Test
	fun theRouteGatewayIsDrawnWithNoSessionsAnywhere() {
		// A machine whose daemon is up but which holds no devcontainers and no sessions contributes no
		// rows at all, and its owner had nothing to press.
		val groups = groupByGateway(emptyList(), listOf("sakura"), adminDomainId = "", homeGatewayId = "sakura")
		assertEquals(listOf("sakura"), keys(groups))
		assertEquals(emptyList<Team>(), groups.single().second)
	}

	@Test
	fun anEmptyRosterInventsNothing() {
		val groups = groupByGateway(emptyList(), emptyList(), adminDomainId = "alice", homeGatewayId = "sakura")
		assertEquals(emptyList<String>(), keys(groups))
	}

	@Test
	fun aPickedProjectStaysBareOnTheRouteGateway() {
		// A bare name means the route Gateway everywhere else; re-spelling it would change what every
		// target that works today resolves to.
		val opened = CreateDialogTarget("alice", "sakura", isLocal = true, projects = listOf("host"))
		assertEquals("host", opened.targetFor("host"))
	}

	@Test
	fun aPickedProjectIsQualifiedOnAnotherGateway() {
		val opened = CreateDialogTarget("alice", "ql-2815", isLocal = false, projects = listOf("host"))
		assertEquals("alice.ql-2815.host", opened.targetFor("host"))
	}

	@Test
	fun anUnqualifiableProjectFallsBackToBareRatherThanACorruptAddress() {
		// A separator in the spawn segment cannot make an Address; a bare target then fails against the
		// route Gateway, which is visible, rather than being sent as something no parser accepts.
		val opened = CreateDialogTarget("alice", "ql-2815", isLocal = false, projects = listOf("a.b"))
		assertEquals("a.b", opened.targetFor("a.b"))
	}

	@Test
	fun emptyBoardKeepsItsCauses() {
		val stalled = ChatState(connected = true, pollFailStreak = 2)
		assertTrue(emptyBoardHasCause(stalled))
		val healthy = ChatState(connected = true)
		assertEquals(false, emptyBoardHasCause(healthy))
	}
}
