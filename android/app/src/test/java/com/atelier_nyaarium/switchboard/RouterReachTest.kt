package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for reachCandidates: the order a phone tries its Router's addresses. The order IS the
 * behaviour - LAN first so a phone at home never pays a hairpin timeout, public next so it works
 * away, the typed address last so an older Router that advertises nothing still resolves - and a
 * wrong order shows up as an outage in exactly one location, which is the kind of bug that took a
 * whole afternoon to see the first time.
 */
class RouterReachTest {

	private val typed = "https://switchboard.example.com:20001"

	@Test
	fun lanBeforePublicBeforeTyped() {
		val reach = RouterReach(publicHost = "switchboard.example.com", lanAddresses = listOf("192.168.1.238"))
		assertEquals(
			listOf("https://192.168.1.238:20001", "https://switchboard.example.com:20001"),
			reachCandidates(reach, typed, 20001),
		)
	}

	@Test
	fun preferredJumpsTheQueueWhenItIsStillACandidate() {
		val reach = RouterReach(
			publicHost = "switchboard.example.com",
			lanAddresses = listOf("192.168.1.238"),
			preferred = "switchboard.example.com",
		)
		assertEquals("https://switchboard.example.com:20001", reachCandidates(reach, typed, 20001).first())
	}

	// A preferred address the Router no longer advertises (a LAN renumber) must not resurrect
	// itself at the head of the list, or the phone dials a dead address first on every connect.
	@Test
	fun aStalePreferredIsIgnored() {
		val reach = RouterReach(lanAddresses = listOf("192.168.1.240"), preferred = "192.168.1.238")
		assertEquals("https://192.168.1.240:20001", reachCandidates(reach, typed, 20001).first())
	}

	@Test
	fun nothingLearnedFallsBackToTheTypedAddressAlone() {
		assertEquals(listOf(typed), reachCandidates(RouterReach(), typed, 20001))
	}

	@Test
	fun typedAddressIsNotListedTwiceWhenItIsAlsoAdvertised() {
		val reach = RouterReach(publicHost = "switchboard.example.com")
		assertEquals(1, reachCandidates(reach, typed, 20001).size)
	}

	@Test
	fun portComesFromTheTypedUrlWhenPresent() {
		assertEquals(8443, reachPort("https://router.example.com:8443", 20001))
		assertEquals(20001, reachPort("https://router.example.com", 20001))
	}
}
