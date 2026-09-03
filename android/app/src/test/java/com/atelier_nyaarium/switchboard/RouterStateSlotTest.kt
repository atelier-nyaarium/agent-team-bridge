package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RouterStateSlotTest {
	private val payload = JsonPrimitive("value")

	@Test
	fun equalOrOlderVersionsAreRejected() {
		val applied = RouterStateSlot(4L, 9L, payload)

		assertFalse(newerRouterState(RouterStateSlot(4L, 9L, JsonPrimitive("equal")), applied))
		assertTrue(newerRouterState(RouterStateSlot(3L, 0L, JsonPrimitive("different epoch")), applied))
		assertTrue(newerRouterState(RouterStateSlot(4L, 10L, JsonPrimitive("new")), applied))
		assertTrue(newerRouterState(RouterStateSlot(5L, 0L, JsonPrimitive("new epoch")), applied))
	}
}
