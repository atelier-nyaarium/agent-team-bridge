package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a Gateways card says, and the durable record behind it. */
class PendingEnrollTest {
	private fun rec(id: String = "mikan", host: String? = "192.168.1.225") =
		PendingEnroll(
			gatewayId = id,
			bundle = "{\"sealed\":true}",
			lanHost = host,
			lanPort = if (host == null) null else 20003,
			certFp = if (host == null) null else "ab".repeat(32),
			at = 1_700_000_000_000,
		)

	@Test
	fun anUnfinishedEnrollmentOutranksAPlainOffline() {
		assertEquals(GatewayCardState.Unfinished(null), gatewayCardState(sessions = 0, online = false, pending = rec()))
	}

	@Test
	fun aSessionOutranksTheRecord() {
		// A session is proof the bundle landed and the Gateway registered, so a record that survived
		// the enrollment is stale and must not argue with what actually happened.
		assertEquals(GatewayCardState.Offline, gatewayCardState(sessions = 2, online = false, pending = rec()))
		assertEquals(GatewayCardState.Live(2), gatewayCardState(sessions = 2, online = true, pending = rec()))
	}

	@Test
	fun withNoRecordTheCardReadsAsItAlwaysDid() {
		assertEquals(GatewayCardState.Offline, gatewayCardState(sessions = 0, online = false, pending = null))
		assertEquals(GatewayCardState.Live(1), gatewayCardState(sessions = 1, online = true, pending = null))
	}

	@Test
	fun theLastFailureRidesTheCard() {
		val state = gatewayCardState(0, false, rec().copy(lastError = "Couldn't reach the Gateway over the LAN."))
		assertEquals(GatewayCardState.Unfinished("Couldn't reach the Gateway over the LAN."), state)
	}

	@Test
	fun onlyACompleteLanTargetIsDeliverable() {
		// A paste-only record can still be resumed, but only by handing the bundle over again.
		assertTrue(rec().deliverable)
		assertEquals(false, rec(host = null).deliverable)
	}

	@Test
	fun aRecordSurvivesARoundTrip() {
		val map = mapOf("mikan" to rec(), "yuzu" to rec(id = "yuzu", host = null))
		assertEquals(map, decodePendingEnrolls(encodePendingEnrolls(map)))
	}

	@Test
	fun aCorruptOrAbsentBlobReadsAsEmptyRatherThanThrowing() {
		// Losing this costs a card that says offline instead of unfinished, which is not worth
		// taking the screen down for.
		assertEquals(emptyMap<String, PendingEnroll>(), decodePendingEnrolls(null))
		assertEquals(emptyMap<String, PendingEnroll>(), decodePendingEnrolls(""))
		assertEquals(emptyMap<String, PendingEnroll>(), decodePendingEnrolls("{ this is not json"))
		assertEquals(emptyMap<String, PendingEnroll>(), decodePendingEnrolls("[1,2,3]"))
	}

	@Test
	fun anUnknownFieldDoesNotPoisonTheWholeFile() {
		// The record gains fields over time and the app that reads it may predate them.
		val text = "{\"mikan\":{\"gatewayId\":\"mikan\",\"bundle\":\"x\",\"somethingNew\":42}}"
		val out = decodePendingEnrolls(text)
		assertEquals(1, out.size)
		assertEquals("x", out["mikan"]?.bundle)
		assertNull(out["mikan"]?.lanHost)
	}
}
