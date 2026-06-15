package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the empty-host key repair that closes the Track C ghost-thread bug: a thread/label
 * key persisted as "/name" (minted before the host id was learned) must repair to
 * "host/name" once the host id is known, matching the canonical key an inbound reply is
 * filed under. Without this, the reply drains and persists but renders into a ghost card
 * the open tab can never read.
 */
class ThreadKeyRepairTest {
	@Test
	fun repairsEmptyHostKeyOnceHostKnown() {
		// The core Track C repair: "/name" -> "host/name".
		assertEquals("switchboard/9cb5b9", canonicalThreadKey("/9cb5b9", "switchboard"))
	}

	@Test
	fun qualifiesBareKey() {
		assertEquals("switchboard/9cb5b9", canonicalThreadKey("9cb5b9", "switchboard"))
	}

	@Test
	fun canonicalIsIdempotent() {
		assertEquals("switchboard/9cb5b9", canonicalThreadKey("switchboard/9cb5b9", "switchboard"))
	}

	@Test
	fun preservesExplicitRemoteHost() {
		// A cross-Host key is not "ours" to re-home; keep it byte-stable.
		assertEquals("hostb/api", canonicalThreadKey("hostb/api", "switchboard"))
	}

	@Test
	fun leavesEmptyHostUnrepairedWhenHostUnknown() {
		// Host not yet learned: nothing to repair to; recanonicalizeAllKeys fixes it later.
		assertEquals("/9cb5b9", canonicalThreadKey("/9cb5b9", ""))
	}

	@Test
	fun repairsEmptyHostInsideConvSessionKey() {
		assertEquals("conv:c1:switchboard/9cb5b9", canonicalThreadKey("conv:c1:/9cb5b9", "switchboard"))
	}
}
