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
}
