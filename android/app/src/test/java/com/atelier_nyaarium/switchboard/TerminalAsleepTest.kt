package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * When the terminal stops peeking and reads as asleep.
 *
 * The defect this pins: an authoritative "available" row was taken as proof there was nothing to
 * show, so closing Claude to use the shell underneath and then reopening the thread landed on "This
 * session is asleep" over a pane that was still alive and typeable.
 */
class TerminalAsleepTest {
	private val now = 1_000L

	private fun presence(status: String, authority: Authority) =
		Presence.reported(status = status, authority = authority, mode = "", queueDepth = 0)

	@Test
	fun `an available session is probed before it is called asleep`() {
		val p = presence(Presence.AVAILABLE, Authority.LIVE)
		assertFalse(terminalReadsAsleep(p, wakeRequested = false, sawPane = false, probed = false, now = now))
	}

	@Test
	fun `a probe that found no pane reads asleep`() {
		val p = presence(Presence.AVAILABLE, Authority.LIVE)
		assertTrue(terminalReadsAsleep(p, wakeRequested = false, sawPane = false, probed = true, now = now))
	}

	@Test
	fun `a pane that was seen keeps the terminal, whatever the row says`() {
		val p = presence(Presence.AVAILABLE, Authority.LIVE)
		assertFalse(terminalReadsAsleep(p, wakeRequested = false, sawPane = true, probed = true, now = now))
	}

	@Test
	fun `an unreachable Gateway is never probed`() {
		val p = presence(Presence.AVAILABLE, Authority.UNREACHABLE)
		assertTrue(terminalReadsAsleep(p, wakeRequested = false, sawPane = false, probed = false, now = now))
	}

	@Test
	fun `a wake cannot make an unreachable Gateway worth peeking`() {
		val p = presence(Presence.AVAILABLE, Authority.UNREACHABLE)
		assertTrue(terminalReadsAsleep(p, wakeRequested = true, sawPane = false, probed = true, now = now))
	}

	@Test
	fun `a wake on a reachable Gateway keeps the terminal watching`() {
		val p = presence(Presence.AVAILABLE, Authority.LIVE)
		assertFalse(terminalReadsAsleep(p, wakeRequested = true, sawPane = false, probed = true, now = now))
	}

	@Test
	fun `a pane already seen outranks an unreachable row`() {
		val p = presence(Presence.AVAILABLE, Authority.UNREACHABLE)
		assertFalse(terminalReadsAsleep(p, wakeRequested = false, sawPane = true, probed = true, now = now))
	}

	@Test
	fun `an online session is never asleep`() {
		val p = presence(Presence.ONLINE, Authority.LIVE)
		assertFalse(terminalReadsAsleep(p, wakeRequested = false, sawPane = false, probed = true, now = now))
	}

	@Test
	fun `no row at all leaves the terminal peeking`() {
		assertFalse(terminalReadsAsleep(null, wakeRequested = false, sawPane = false, probed = true, now = now))
	}
}
