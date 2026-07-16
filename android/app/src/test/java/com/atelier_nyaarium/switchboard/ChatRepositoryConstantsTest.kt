package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins ChatRepository constants whose correctness depends on a value that lives in the
 * gateway's TypeScript, not on anything Kotlin can check at compile time. A failure here means
 * one side changed without the other - go update both src/gateway/... and ChatRepository.kt.
 */
class ChatRepositoryConstantsTest {

	@Test
	fun maxOutgoingBytesMatchesGatewayMaxResponseFileBytes() {
		// src/gateway/routes.ts: const MAX_RESPONSE_FILE_BYTES = 500_000_000
		assertEquals(500_000_000, ChatRepository.MAX_OUTGOING_BYTES)
	}

	@Test
	fun spawnRetryWindowStaysComfortablyPastGatewayCreateSessionBound() {
		// src/gateway/console/consoleHandler.ts: const CREATE_SESSION_BOUND_MS = 25_000
		val gatewayCreateSessionBoundMs = 25_000L
		assertTrue(
			"SPAWN_RETRY_WINDOW_MS must stay comfortably past the gateway's create_session bound",
			ChatRepository.SPAWN_RETRY_WINDOW_MS > gatewayCreateSessionBoundMs + 10_000L,
		)
	}

	@Test
	fun heldReadTimeoutStaysUnderTheApiserverProxyCeiling() {
		// The binding constraint on the whole long-poll chain (see ConsoleClient.poll's comment):
		// the client's held read timeout must return before the untracked apiserver proxy resets
		// the socket. Deliberately thin headroom (58s < 60s) - pinned strict, not loose.
		assertTrue(
			"LONG_POLL_HOLD_MS + HELD_READ_MARGIN_MS must stay under PROXY_CEILING_MS",
			ChatRepository.LONG_POLL_HOLD_MS + ConsoleClient.HELD_READ_MARGIN_MS < ConsoleClient.PROXY_CEILING_MS,
		)
	}

	@Test
	fun longPollHoldStaysAtOrUnderTheGatewaysHoldCap() {
		// src/shared/schemas.ts: MAX_POLL_HOLD_MS = 45_000 (the zod holdMs .max() - the real hard
		// gate; a larger hold is rejected outright, not silently truncated).
		val gatewayMaxPollHoldMs = 45_000L
		assertTrue(
			"LONG_POLL_HOLD_MS must not exceed the gateway's hold cap",
			ChatRepository.LONG_POLL_HOLD_MS <= gatewayMaxPollHoldMs,
		)
	}

	@Test
	fun heldTimeoutsStayStrictlyOrderedCallTimeoutAboveReadTimeoutAboveHold() {
		val hold = ChatRepository.LONG_POLL_HOLD_MS
		val heldReadTimeoutMs = hold + ConsoleClient.HELD_READ_MARGIN_MS
		val heldCallTimeoutMs = heldReadTimeoutMs + ConsoleClient.CALL_TIMEOUT_MARGIN_MS + ConsoleClient.PINNED_CONNECT_TIMEOUT_MS
		assertTrue("held callTimeout must exceed held readTimeout", heldCallTimeoutMs > heldReadTimeoutMs)
		assertTrue("held readTimeout must exceed the hold itself", heldReadTimeoutMs > hold)
	}
}
