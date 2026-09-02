package com.atelier_nyaarium.switchboard

import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConsoleTransportCoordinatorTest {
	@Test
	fun defaultsToPolling() {
		val coordinator = newCoordinator()

		assertEquals(ConsoleLink.POLL, coordinator.link())
		assertTrue(coordinator.mayPoll())
	}

	@Test
	fun welcomeAdoptsSocketAndRouterCursor() {
		val coordinator = newCoordinator()
		val generation = coordinator.beginSocket()

		assertEquals(
			ConsoleAdoption.Adopted(cursor = 42L, cursorEpoch = 7L, dropped = 0L),
			coordinator.onWelcome(generation, cursor = 42L, cursorEpoch = 7L, floor = 43L),
		)
		assertEquals(ConsoleLink.SOCKET, coordinator.link())
		assertEquals(42L, coordinator.cursor())
		assertFalse(coordinator.mayPoll())
	}

	@Test
	fun staleWelcomeDoesNotAdoptAfterReconnect() {
		val coordinator = newCoordinator()
		val first = coordinator.beginSocket()
		coordinator.beginSocket()

		assertEquals(ConsoleAdoption.Stale, coordinator.onWelcome(first, cursor = 8L, cursorEpoch = 2L, floor = 9L))
		assertEquals(ConsoleLink.POLL, coordinator.link())
	}

	@Test
	fun droppedRowsAccumulateAndClear() {
		val coordinator = newCoordinator()
		val first = coordinator.beginSocket()
		val firstAdoption = coordinator.onWelcome(first, cursor = 10L, cursorEpoch = 1L, floor = 13L)
		val second = coordinator.beginSocket()
		val secondAdoption = coordinator.onWelcome(second, cursor = 20L, cursorEpoch = 2L, floor = 24L)

		assertEquals(ConsoleAdoption.Adopted(cursor = 10L, cursorEpoch = 1L, dropped = 2L), firstAdoption)
		assertEquals(ConsoleAdoption.Adopted(cursor = 20L, cursorEpoch = 2L, dropped = 3L), secondAdoption)
		assertEquals(5L, coordinator.dropped)

		val boundary = newCoordinator()
		val boundaryGeneration = boundary.beginSocket()
		assertEquals(ConsoleAdoption.Adopted(cursor = 30L, cursorEpoch = 3L, dropped = 0L), boundary.onWelcome(boundaryGeneration, 30L, 3L, 31L))
		coordinator.clearDropped()
		assertEquals(0L, coordinator.dropped)
	}

	@Test
	fun ackedOnlyAdvancesForLiveGeneration() {
		val coordinator = newCoordinator()
		val first = coordinator.beginSocket()
		coordinator.onWelcome(first, cursor = 10L, cursorEpoch = 1L, floor = 11L)

		assertFalse(coordinator.acked(first, 9L))
		assertFalse(coordinator.acked(first, 10L))
		assertEquals(10L, coordinator.cursor())

		val live = coordinator.beginSocket()
		assertFalse(coordinator.acked(first, 12L))
		assertEquals(10L, coordinator.cursor())
		assertTrue(coordinator.acked(live, 12L))
		assertEquals(12L, coordinator.cursor())
	}

	@Test
	fun closingLiveSocketReturnsToPolling() {
		val coordinator = newCoordinator()
		val live = coordinator.beginSocket()
		coordinator.onWelcome(live, cursor = 1L, cursorEpoch = 1L, floor = 2L)

		coordinator.onSocketClosed(live)

		assertEquals(ConsoleLink.POLL, coordinator.link())
		assertTrue(coordinator.mayPoll())
	}

	@Test
	fun staleSocketCloseDoesNothing() {
		val coordinator = newCoordinator()
		val first = coordinator.beginSocket()
		coordinator.onWelcome(first, cursor = 1L, cursorEpoch = 1L, floor = 2L)
		val live = coordinator.beginSocket()

		coordinator.onSocketClosed(first)

		assertEquals(ConsoleLink.SOCKET, coordinator.link())
		assertFalse(coordinator.mayPoll())
		assertTrue(coordinator.owns(live))
	}

	@Test
	fun backgroundingReturnsToPollingAndForegroundingDoesNotAdoptSocket() {
		val coordinator = newCoordinator()
		val live = coordinator.beginSocket()
		coordinator.onWelcome(live, cursor = 1L, cursorEpoch = 1L, floor = 2L)

		coordinator.onVisibility(false)
		coordinator.onVisibility(true)

		assertEquals(ConsoleLink.POLL, coordinator.link())
		assertTrue(coordinator.mayPoll())
	}

	@Test
	fun nextWaitParksSocketAndUsesPushbackWhilePolling() {
		var now = 0L
		val pushback = IdlePushbackManager(FakeStore(), 0L) { ZoneId.of("UTC") }
		val coordinator = ConsoleTransportCoordinator(pushback) { now }
		val live = coordinator.beginSocket()
		coordinator.onWelcome(live, cursor = 1L, cursorEpoch = 1L, floor = 2L)

		assertEquals(PollWait.Delay(SOCKET_PARK_MS), coordinator.nextWait(true, false, false))

		coordinator.onSocketClosed(live)
		val foreground = coordinator.nextWait(true, false, false)
		assertEquals(PollWait.Chain, foreground)
		now = 600_000L
		val expected = pushback.decide(now, false, false, false)
		assertEquals(expected, coordinator.nextWait(false, false, false))
		assertTrue(expected is PollWait.Alarm)
	}

	@Test
	fun ownsOnlyLiveSocketGeneration() {
		val coordinator = newCoordinator()
		val generation = coordinator.beginSocket()
		coordinator.onWelcome(generation, cursor = 1L, cursorEpoch = 1L, floor = 2L)

		assertTrue(coordinator.owns(generation))
		coordinator.onSocketClosed(generation)
		assertFalse(coordinator.owns(generation))
	}

	private fun newCoordinator(): ConsoleTransportCoordinator {
		val pushback = IdlePushbackManager(FakeStore(), 0L) { ZoneId.of("UTC") }
		return ConsoleTransportCoordinator(pushback)
	}

	private class FakeStore : IdleSilenceStore {
		private var value: Long? = null

		override fun loadIdleSilenceStart(): Long? = value

		override fun saveIdleSilenceStart(v: Long) {
			value = v
		}
	}
}
