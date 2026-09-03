package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

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
	fun lanStaysFirstEvenAfterTheLastConnectionWasPublic() {
		val reach = RouterReach(publicHost = "switchboard.example.com", lanAddresses = listOf("192.168.1.238"))
		assertEquals("https://192.168.1.238:20001", reachCandidates(reach, typed, 20001).first())
	}

	@Test
	fun privateAddressesAreRecognisedForTheShortTimeout() {
		listOf("192.168.1.238", "10.0.0.5", "172.16.4.4", "172.31.255.1", "127.0.0.1", "localhost")
			.forEach { assertEquals(it, true, isPrivateHost(it)) }
		listOf("switchboard.example.com", "99.47.67.157", "172.56.15.53", "8.8.8.8")
			.forEach { assertEquals(it, false, isPrivateHost(it)) }
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

	@Test
	fun publicPortNeverLeaksOntoLanCandidates() {
		val reach = RouterReach(publicHost = "switchboard.example.com", publicPort = 8443, lanAddresses = listOf("192.168.1.238"))
		assertEquals(
			listOf("https://192.168.1.238:20001", "https://switchboard.example.com:8443", typed),
			reachCandidates(reach, typed, 20001),
		)
	}

	@Test
	fun absentPublicPortMeansTheRoutersOwn() {
		val reach = RouterReach(publicHost = "switchboard.example.com", lanAddresses = listOf("192.168.1.238"))
		assertEquals("https://switchboard.example.com:20001", reachCandidates(reach, typed, 20001)[1])
	}

	@Test
	fun publicPortSurvivesTheStoreRoundTrip() {
		val reach = RouterReach(publicHost = "switchboard.example.com", publicPort = 8443, lanAddresses = listOf("10.0.0.5"))
		assertEquals(reach, RouterReach.decode(reach.encode()))
		// Legacy records have no port.
		assertEquals(null, RouterReach.decode("""{"publicHost":"a","lanAddresses":[]}""").publicPort)
	}

	private val lan = "https://192.168.1.238:20001"
	private val public = "https://switchboard.example.com:20001"

	@Test
	fun walkingOffTheLanReachesThePublicHostAndComesBack() {
		val ring = listOf(lan, public)
		val away = nextReachIndex(ring, 0, lan)
		assertEquals(1, away)
		assertEquals(0, nextReachIndex(ring, away!!, public))
	}

	@Test
	fun aBaseThatIsNoLongerCurrentDoesNotAdvancePastTheMove() {
		assertEquals(1, nextReachIndex(listOf(lan, public), 1, lan))
	}

	@Test
	fun aSoleCandidateHasNowhereToFailOver() {
		assertEquals(null, nextReachIndex(listOf(lan), 0, lan))
		assertEquals(null, nextReachIndex(emptyList(), 0, lan))
	}
}
