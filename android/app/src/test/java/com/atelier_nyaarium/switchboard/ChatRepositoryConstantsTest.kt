package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins numeric relationships that Kotlin cannot check at compile time - either because the
 * other side lives in the gateway's TypeScript (a failure means go update both src/gateway/...
 * and the Kotlin side), or because two independently-declared Kotlin constants (ChatRepository's
 * and ConsoleClient's) must stay ordered relative to each other and nothing but this test
 * enforces it.
 */
class ChatRepositoryConstantsTest {

	@Test
	fun maxOutgoingBytesDerivesFromTheGeneratedWireLimitRatherThanRestatingIt() {
		// Was a hand-copied 16 MB literal on both sides. That number existed only because the old path
		// base64'd a whole file into the heap, and when that path was deleted the literal stayed - so
		// the console kept refusing exactly the large files the chunked transport was built to carry.
		// Asserting the derivation is the guard; a literal here would just be another copy to drift.
		assertEquals(Protocol.MAX_BLOB_BYTES, ChatRepository.MAX_OUTGOING_BYTES)
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
	fun pinnedReadTimeoutOutlastsGatewaysSendBound() {
		// src/gateway/console/consoleHandler.ts: const SEND_BOUND_MS = 25_000 - the relay holds a
		// send op server-side up to this long before answering "running"; ConsoleClient's shared
		// read timeout (every non-held relay() call, including send()) must outlast it or a
		// cold-wake send gets mislabeled as failed on the client. Same ceiling and reasoning as
		// CREATE_SESSION_BOUND_MS above - this is its sibling pin.
		val gatewaySendBoundMs = 25_000L
		assertTrue(
			"PINNED_READ_TIMEOUT_MS must stay comfortably past the gateway's send bound",
			ConsoleHttp.PINNED_READ_TIMEOUT_MS > gatewaySendBoundMs + 5_000L,
		)
	}

	@Test
	fun heldReadWindowOutlastsTheRoutersOwnHold() {
		// The binding constraint on the whole long-poll chain (see ConsoleClient.poll's comment): the
		// Router answers a held poll at ROUTER_HOLD_MS, so the client's read window must still be open
		// then. Undercut it and every held poll fails here while the Router is answering normally.
		assertTrue(
			"LONG_POLL_HOLD_MS + HELD_READ_MARGIN_MS must outlast ROUTER_HOLD_MS",
			ChatRepository.LONG_POLL_HOLD_MS + ConsoleHttp.HELD_READ_MARGIN_MS > ConsoleHttp.ROUTER_HOLD_MS,
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
		val heldReadTimeoutMs = hold + ConsoleHttp.HELD_READ_MARGIN_MS
		val heldCallTimeoutMs = heldReadTimeoutMs + ConsoleHttp.CALL_TIMEOUT_MARGIN_MS + ConsoleHttp.PINNED_CONNECT_TIMEOUT_MS
		assertTrue("held callTimeout must exceed held readTimeout", heldCallTimeoutMs > heldReadTimeoutMs)
		assertTrue("held readTimeout must exceed the hold itself", heldReadTimeoutMs > hold)
	}
}
