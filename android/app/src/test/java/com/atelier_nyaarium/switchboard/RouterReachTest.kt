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

	// The ordering is a FIXED rule, never "whatever worked last". Connecting once from away used to
	// record the public host as preferred, which then jumped the queue at home and paid a full
	// hairpin timeout on every cold start - the rare case optimised, the common one pessimised.
	@Test
	fun lanStaysFirstEvenAfterTheLastConnectionWasPublic() {
		val reach = RouterReach(publicHost = "switchboard.example.com", lanAddresses = listOf("192.168.1.238"))
		assertEquals("https://192.168.1.238:20001", reachCandidates(reach, typed, 20001).first())
	}

	// Trying LAN first is only cheap because a private address gets seconds, not the full connect
	// timeout: away from home it is unroutable, and that wait is the entire cost of the rule.
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

	// A port forward remaps the public port and nothing else. Dialing the LAN on the forwarded port
	// reaches nothing at home, which is the one place the LAN rule is supposed to be cheap.
	@Test
	fun publicPortNeverLeaksOntoLanCandidates() {
		val reach = RouterReach(publicHost = "switchboard.example.com", publicPort = 8443, lanAddresses = listOf("192.168.1.238"))
		assertEquals(
			listOf("https://192.168.1.238:20001", "https://switchboard.example.com:8443", typed),
			reachCandidates(reach, typed, 20001),
		)
	}

	// An older Router that names a public host and no port means its own port, not one this device
	// might remember from somewhere else.
	@Test
	fun absentPublicPortMeansTheRoutersOwn() {
		val reach = RouterReach(publicHost = "switchboard.example.com", lanAddresses = listOf("192.168.1.238"))
		assertEquals("https://switchboard.example.com:20001", reachCandidates(reach, typed, 20001)[1])
	}

	@Test
	fun publicPortSurvivesTheStoreRoundTrip() {
		val reach = RouterReach(publicHost = "switchboard.example.com", publicPort = 8443, lanAddresses = listOf("10.0.0.5"))
		assertEquals(reach, RouterReach.decode(reach.encode()))
		// A record written before the field existed decodes with none, never a default number.
		assertEquals(null, RouterReach.decode("""{"publicHost":"a","lanAddresses":[]}""").publicPort)
	}

	private val lan = "https://192.168.1.238:20001"
	private val public = "https://switchboard.example.com:20001"

	@Test
	fun walkingOffTheLanReachesThePublicHostAndComesBack() {
		val ring = listOf(lan, public)
		val away = nextReachIndex(ring, 0, lan)
		assertEquals(1, away)
		// Wrap to retry LAN after returning home.
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
