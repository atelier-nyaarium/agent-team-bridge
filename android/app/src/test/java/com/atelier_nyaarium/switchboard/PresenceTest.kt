package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rule that decides whether a session is worth peeking, and what a presence answer is worth.
 *
 * The defect these cover: a session's facts arrive PUSHED for the route Gateway and PULLED once per
 * discovery interval for every other machine, and before Presence existed nothing carried that
 * difference, so `status == "available"` was written at fourteen sites by code that could not tell a
 * current row from a thirty-second-old one.
 */
class PresenceTest {
	private val now = 1_000_000L

	private fun row(status: String, authority: Authority = Authority.LIVE) =
		Presence.reported(status = status, authority = authority)

	////////////////////////////////
	//  What a row is worth

	@Test
	fun onlyThePushedPlaneIsAuthoritative() {
		assertTrue(row(Presence.AVAILABLE, Authority.LIVE).authoritative)
		assertFalse(row(Presence.AVAILABLE, Authority.POLLED).authoritative)
		assertFalse(row(Presence.AVAILABLE, Authority.UNREACHABLE).authoritative)
		assertFalse(row(Presence.AVAILABLE, Authority.NONE).authoritative)
	}

	@Test
	fun theStatusVocabularyHasOneOwner() {
		assertEquals("live", row(Presence.ONLINE).word)
		assertEquals("verifying", row(Presence.VERIFYING).word)
		assertEquals("available", row(Presence.AVAILABLE).word)
		assertEquals("ended", Presence.ended().word)
		// Anything unrecognised reads as ended rather than leaking a raw wire token into the UI.
		assertEquals("ended", Presence.wordFor("something-new"))
	}

	@Test
	fun liveCoversVerifyingButOnlineDoesNot() {
		assertTrue(row(Presence.ONLINE).isLive)
		assertTrue(row(Presence.VERIFYING).isLive)
		assertFalse(row(Presence.AVAILABLE).isLive)
		assertTrue(row(Presence.ONLINE).isOnline)
		assertFalse(row(Presence.VERIFYING).isOnline)
		assertTrue(row(Presence.VERIFYING).isVerifying)
	}

	////////////////////////////////
	//  The peek gate

	@Test
	fun anAwakeSessionIsAlwaysWorthPeeking() {
		for (a in Authority.entries.filter { it != Authority.UNREACHABLE && it != Authority.NONE }) {
			assertTrue("$a", row(Presence.ONLINE, a).mayHavePane(now))
			assertTrue("$a", row(Presence.VERIFYING, a).mayHavePane(now))
		}
	}

	@Test
	fun anAsleepSessionIsNotWorthPeeking() {
		assertFalse(row(Presence.AVAILABLE, Authority.LIVE).mayHavePane(now))
		assertFalse(row(Presence.AVAILABLE, Authority.POLLED).mayHavePane(now))
	}

	@Test
	fun anUnreachableGatewayIsNeverPeeked() {
		// The bound that stops one wake tap on a powered-off machine from becoming a peek every
		// couple of seconds. It holds even for a row that still claims the session was up, because
		// that claim is exactly what an unreachable gateway's held row is made of.
		for (s in listOf(Presence.ONLINE, Presence.VERIFYING, Presence.AVAILABLE)) {
			assertFalse(s, row(s, Authority.UNREACHABLE).mayHavePane(now))
			assertFalse(s, row(s, Authority.UNREACHABLE).withReceipt(ActionReceipt("op", now)).mayHavePane(now))
		}
	}

	@Test
	fun aSessionThisDeviceAskedToWakeIsWorthPeekingOnEveryMachine() {
		// The reported bug: on a non-route Gateway the row stays "available" for up to a discovery
		// interval after the wake, so without the receipt the terminal never peeks and stays blank.
		val asked = row(Presence.AVAILABLE, Authority.POLLED).withReceipt(ActionReceipt("op", now))
		assertTrue(asked.mayHavePane(now))
		assertTrue(asked.waking(now))
	}

	////////////////////////////////
	//  Receipts

	@Test
	fun aFailedRequestStopsClaimingAnythingImmediately() {
		val failed = ActionReceipt("op", now, ActionReceipt.Outcome.FAILED)
		val p = row(Presence.AVAILABLE, Authority.POLLED).withReceipt(failed)
		assertFalse(p.waking(now))
		assertFalse(p.mayHavePane(now))
	}

	@Test
	fun anAcceptedRequestKeepsCountingUntilEvidenceOrTheBound() {
		val accepted = ActionReceipt("op", now, ActionReceipt.Outcome.ACCEPTED)
		assertTrue(accepted.live(now))
		assertTrue(accepted.live(now + ActionReceipt.RECEIPT_TTL_MS - 1))
		assertFalse(accepted.live(now + ActionReceipt.RECEIPT_TTL_MS))
	}

	@Test
	fun theBoundOutlastsADiscoveryInterval() {
		// Shorter than one discovery pull and a slow cold boot would expire the receipt before the
		// roster has spoken even once, which puts the blank terminal straight back.
		assertTrue(ActionReceipt.RECEIPT_TTL_MS > ChatRepository.DISCOVERY_REFRESH_MS)
	}

	@Test
	fun evidenceOutranksARequest() {
		// A row that already says the session is up must not read as "waking": an optimistic value
		// that can outrank a real report is a UI that lies, which is worse than one that is late.
		val p = row(Presence.ONLINE, Authority.POLLED).withReceipt(ActionReceipt("op", now))
		assertFalse(p.waking(now))
	}

	@Test
	fun anExpiredRequestLeavesTheRowItself() {
		val old = ActionReceipt("op", now - ActionReceipt.RECEIPT_TTL_MS - 1)
		val p = row(Presence.AVAILABLE, Authority.POLLED).withReceipt(old)
		assertFalse(p.waking(now))
		assertFalse(p.mayHavePane(now))
	}

	////////////////////////////////
	//  Construction

	@Test
	fun anEndedThreadClaimsNoGateway() {
		val e = Presence.ended()
		assertTrue(e.hasEnded)
		assertFalse(e.isLive)
		assertEquals(Authority.NONE, e.authority)
		assertFalse(e.mayHavePane(now))
		assertNull(e.receipt)
	}

	@Test
	fun reStampingKeepsEverythingElse() {
		val p = Presence.reported(
			status = Presence.ONLINE,
			authority = Authority.POLLED,
			mode = "m",
			queueDepth = 3,
			version = "9.9.9",
			working = true,
			needsLogin = false,
			limitBlocked = true,
			limitDetail = "resets 5pm",
		)
		val re = p.withAuthority(Authority.LIVE).withReceipt(ActionReceipt("op", now))
		assertEquals(Authority.LIVE, re.authority)
		assertEquals("m", re.mode)
		assertEquals(3, re.queueDepth)
		assertEquals("9.9.9", re.version)
		assertEquals(true, re.working)
		assertEquals(false, re.needsLogin)
		assertEquals(true, re.limitBlocked)
		assertEquals("resets 5pm", re.limitDetail)
		assertTrue(re.isOnline)
	}
}
