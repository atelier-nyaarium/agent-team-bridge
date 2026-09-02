package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleInboxRowsFrame
import com.atelier_nyaarium.switchboard.proto.ConsolePlaneFrame
import com.atelier_nyaarium.switchboard.proto.ConsoleWelcomeFrame
import com.atelier_nyaarium.switchboard.proto.InboxRow
import com.atelier_nyaarium.switchboard.proto.OpKey
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.RowEnvelope
import com.atelier_nyaarium.switchboard.proto.RowOrigin
import java.lang.reflect.Proxy
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConsoleSocketDriverTest {
	@Test
	fun connectWelcomeAdoptsSocket() {
		val coordinator = newCoordinator()
		val h = harness(coordinator)

		h.driver.connect()
		h.wireListeners.single().onMessage(h.socket, welcomeJson(cursor = 4L, epoch = 8L, floor = 5L))

		assertEquals(ConsoleLink.SOCKET, coordinator.link())
		assertEquals(4L, coordinator.cursor())
	}

	@Test
	fun rowsAreDeliveredBeforeCursorIsAcked() {
		val coordinator = newCoordinator()
		val events = mutableListOf<String>()
		val rows = listOf(row())
		val h = harness(coordinator, onRows = { received, cursor ->
			events += "rows"
			assertEquals(rows, received)
			assertEquals(4L, cursor)
		}, onAck = { events += "ack" })
		h.driver.connect()
		val clientListener = h.wireListeners.single()
		clientListener.onMessage(h.socket, welcomeJson(cursor = 1L, epoch = 8L, floor = 2L))

		h.listenerListeners.single().onFrame(
			ConsoleSocketFrame.InboxRows(ConsoleInboxRowsFrame(incarnation = 8L, rows = rows, cursor = 4L)),
		)

		assertEquals(listOf("rows", "ack"), events)
		assertEquals(4L, coordinator.cursor())
	}

	@Test
	fun supersededRowsAreDropped() {
		val coordinator = newCoordinator()
		var rowsCalled = false
		val h = harness(coordinator, onRows = { _, _ -> rowsCalled = true })
		h.driver.connect()
		val first = h.listenerListeners.single()
		h.driver.connect()
		val second = h.listenerListeners.last()
		second.onFrame(
			ConsoleSocketFrame.Welcome(
				ConsoleWelcomeFrame(incarnation = 2L, cursor = 2L, cursorEpoch = 1L, floor = 3L, versions = JsonObject(emptyMap())),
			),
		)

		first.onFrame(
			ConsoleSocketFrame.InboxRows(ConsoleInboxRowsFrame(incarnation = 1L, rows = listOf(row()), cursor = 9L)),
		)

		assertFalse(rowsCalled)
		assertEquals(2L, coordinator.cursor())
	}

	@Test
	fun planeIsDeliveredAndSupersededPlaneIsDropped() {
		val coordinator = newCoordinator()
		val planes = mutableListOf<Pair<String, Long>>()
		val h = harness(coordinator, onPlane = { name, version -> planes += name to version })
		h.driver.connect()
		val first = h.listenerListeners.single()
		h.driver.connect()
		val second = h.listenerListeners.last()
		second.onFrame(
			ConsoleSocketFrame.Welcome(
				ConsoleWelcomeFrame(incarnation = 2L, cursor = 2L, cursorEpoch = 1L, floor = 3L, versions = JsonObject(emptyMap())),
			),
		)

		first.onFrame(
			ConsoleSocketFrame.Plane(
				ConsolePlaneFrame(incarnation = 1L, name = "presence", version = 7L, payload = JsonObject(emptyMap())),
			),
		)
		second.onFrame(
			ConsoleSocketFrame.Plane(
				ConsolePlaneFrame(incarnation = 2L, name = "presence", version = 8L, payload = JsonObject(emptyMap())),
			),
		)

		assertEquals(listOf("presence" to 8L), planes)
	}

	@Test
	fun refusedRetiresSocketAndKicksPoll() {
		val coordinator = newCoordinator()
		var kicks = 0
		val h = harness(coordinator, kick = { kicks += 1 })
		h.driver.connect()
		h.listenerListeners.single().onFrame(
			ConsoleSocketFrame.Welcome(
				ConsoleWelcomeFrame(incarnation = 1L, cursor = 1L, cursorEpoch = 1L, floor = 2L, versions = JsonObject(emptyMap())),
			),
		)

		h.wireListeners.single().onMessage(h.socket, "{\"type\":\"refused\",\"reason\":\"cursor_stale\"}")

		assertEquals(ConsoleLink.POLL, coordinator.link())
		assertEquals(1, kicks)
		assertEquals(1, h.closeCalls[0])
	}

	@Test
	fun closedSocketReturnsToPollingAndKicks() {
		val coordinator = newCoordinator()
		var kicks = 0
		val h = harness(coordinator, kick = { kicks += 1 })
		h.driver.connect()
		val listener = h.listenerListeners.single()
		listener.onFrame(
			ConsoleSocketFrame.Welcome(
				ConsoleWelcomeFrame(incarnation = 1L, cursor = 1L, cursorEpoch = 1L, floor = 2L, versions = JsonObject(emptyMap())),
			),
		)

		listener.onClosed(1000, "closed", null)

		assertEquals(ConsoleLink.POLL, coordinator.link())
		assertEquals(1, kicks)
	}

	@Test
	fun disconnectClosesLiveClientAndLaterCloseIsHarmless() {
		val coordinator = newCoordinator()
		val h = harness(coordinator)
		h.driver.connect()
		val listener = h.listenerListeners.single()
		listener.onFrame(
			ConsoleSocketFrame.Welcome(
				ConsoleWelcomeFrame(incarnation = 1L, cursor = 1L, cursorEpoch = 1L, floor = 2L, versions = JsonObject(emptyMap())),
			),
		)

		h.driver.disconnect()
		listener.onClosed(1000, "closed", null)

		assertEquals(1, h.closeCalls[0])
		assertEquals(ConsoleLink.POLL, coordinator.link())
	}

	@Test
	fun welcomeGapCallsOnGapWithDroppedCount() {
		val coordinator = newCoordinator()
		val gaps = mutableListOf<Long>()
		val h = harness(coordinator, onGap = { gaps += it })
		h.driver.connect()

		h.wireListeners.single().onMessage(h.socket, welcomeJson(cursor = 10L, epoch = 8L, floor = 14L))

		assertEquals(listOf(3L), gaps)
	}

	@Test
	fun dyingBeforeWelcomeReportsTheAddressUnreachable() {
		val coordinator = newCoordinator()
		var unreachable = 0
		val h = harness(coordinator, onUnreachable = { unreachable += 1 })
		h.driver.connect()

		h.listenerListeners.single().onClosed(null, null, java.io.IOException("no route"))

		assertEquals(1, unreachable)
	}

	// Post-welcome drops do not trigger address failover.
	@Test
	fun dyingAfterWelcomeLeavesTheAddressAlone() {
		val coordinator = newCoordinator()
		var unreachable = 0
		val h = harness(coordinator, onUnreachable = { unreachable += 1 })
		h.driver.connect()
		val listener = h.listenerListeners.single()
		listener.onFrame(ConsoleSocketFrame.Welcome(ConsoleWelcomeFrame(incarnation = 1L, cursor = 1L, cursorEpoch = 1L, floor = 2L, versions = JsonObject(emptyMap()))))

		listener.onClosed(null, null, java.io.IOException("dropped"))

		assertEquals(0, unreachable)
	}

	// A losing reconnect's close must not clear the socket that replaced it, or the winner can no
	// longer ack and disconnect finds nothing to close.
	@Test
	fun aSupersededCloseLeavesTheLiveSocketAlone() {
		val coordinator = newCoordinator()
		val h = harness(coordinator)
		h.driver.connect()
		val first = h.listenerListeners.single()
		h.driver.connect()
		val second = h.listenerListeners.last()
		second.onFrame(ConsoleSocketFrame.Welcome(ConsoleWelcomeFrame(incarnation = 2L, cursor = 2L, cursorEpoch = 1L, floor = 3L, versions = JsonObject(emptyMap()))))

		first.onClosed(1000, "closed", null)
		h.driver.disconnect()

		assertEquals(1, h.closeCalls[0])
	}

	private data class Harness(
		val driver: ConsoleSocketDriver,
		val listenerListeners: MutableList<ConsoleSocketListener>,
		val wireListeners: MutableList<WebSocketListener>,
		val socket: WebSocket,
		val closeCalls: IntArray,
	)

	private fun harness(
		coordinator: ConsoleTransportCoordinator,
		onRows: (List<InboxRow>, Long) -> Unit = { _, _ -> },
		onPlane: (String, Long) -> Unit = { _, _ -> },
		onGap: (Long) -> Unit = {},
		onAck: () -> Unit = {},
		kick: () -> Unit = {},
		onUnreachable: () -> Unit = {},
	): Harness {
		val listenerListeners = mutableListOf<ConsoleSocketListener>()
		val wireListeners = mutableListOf<WebSocketListener>()
		val closeCalls = intArrayOf(0)
		val socket = Proxy.newProxyInstance(
			WebSocket::class.java.classLoader,
			arrayOf(WebSocket::class.java),
		) { _, method, args ->
			when (method.name) {
				"send" -> {
					if (args!![0].toString().contains("\"type\":\"ack\"")) onAck()
					true
				}
				"close" -> {
					closeCalls[0] += 1
					true
				}
				"cancel" -> true
				"request" -> Request.Builder().url("https://router/console").build()
				"queueSize" -> 0L
				"toString" -> "fake"
				else -> null
			}
		} as WebSocket

		val driver = ConsoleSocketDriver(
			coordinator = coordinator,
			newClient = { listener ->
				listenerListeners += listener
				ConsoleSocketClient(
					FakeTransport(),
					{ ownerOp() },
					listener,
				) { _, _, webSocketListener ->
					wireListeners += webSocketListener
					socket
				}
			},
			onRows = onRows,
			onPlane = onPlane,
			onGap = onGap,
			kick = kick,
			onUnreachable = onUnreachable,
		)
		return Harness(driver, listenerListeners, wireListeners, socket, closeCalls)
	}

	private fun newCoordinator() = ConsoleTransportCoordinator(
		IdlePushbackManager(FakeStore(), 0L) { java.time.ZoneId.of("UTC") },
	)

	private fun welcomeJson(cursor: Long, epoch: Long, floor: Long) =
		"{\"type\":\"welcome\",\"incarnation\":8,\"cursor\":$cursor,\"cursorEpoch\":$epoch,\"floor\":$floor,\"versions\":{}}"

	private fun row() = InboxRow(
		envelope = RowEnvelope(
			RowOrigin("gateway", "domain"),
			OpKey("conversation", "op"),
			JsonNull,
			"kind",
			emptyList(),
		),
		producerSig = "signature",
		body = JsonNull,
		seq = 1L,
		acceptedAt = 2L,
		size = 3L,
	)

	private fun ownerOp() = OwnerOp(
		v = 1L,
		domainId = "domain",
		signerSignPub = "signer",
		conversationId = "conversation",
		device = "device",
		opId = "op",
		at = 1L,
		nonce = "nonce",
		op = JsonObject(emptyMap()),
		signature = "signed",
	)

	private class FakeStore : IdleSilenceStore {
		override fun loadIdleSilenceStart(): Long? = null
		override fun saveIdleSilenceStart(v: Long) = Unit
	}

	private class FakeTransport : ConsoleSocketTransport {
		override val proxyBase = "https://router"
		override val appToken = "token"
		override fun clientFor(base: String) = OkHttpClient()
	}
}
