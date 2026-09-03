package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleInboxRowsFrame
import com.atelier_nyaarium.switchboard.proto.ConsolePlaneFrame
import com.atelier_nyaarium.switchboard.proto.ConsoleRefusedFrame
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
		val h = harness(coordinator, clientMode = ConsoleSocketMode.INBOX, onRows = { received, cursor ->
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
	fun planesOnlyKeyRowsAreDispatchedWithoutAck() {
		val coordinator = newCoordinator()
		var dispatched = false
		var acks = 0
		val h = harness(coordinator, onRows = { received, _ -> dispatched = received.single().envelope.kind == "key_grant" }, onAck = { acks++ })
		h.driver.connect()
		val clientListener = h.wireListeners.single()
		clientListener.onMessage(h.socket, welcomeJson(cursor = 1L, epoch = 8L, floor = 2L))
		val keyRow = row().copy(envelope = row().envelope.copy(kind = "key_grant"))

		h.listenerListeners.single().onFrame(
			ConsoleSocketFrame.InboxRows(ConsoleInboxRowsFrame(incarnation = 8L, rows = listOf(keyRow), cursor = 4L)),
		)

		assertTrue(dispatched)
		assertEquals(0, acks)
		assertEquals(1L, coordinator.cursor())
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
		val h = harness(coordinator, onPlane = { name, version, _ -> planes += name to version })
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
	fun refusedThenSocketCloseSchedulesOneReconnect() {
		val coordinator = newCoordinator()
		val reconnects = mutableListOf<Long>()
		val h = harness(coordinator, reconnect = { reconnects += it })
		h.driver.connect()
		val listener = h.listenerListeners.single()

		listener.onFrame(ConsoleSocketFrame.Refused(ConsoleRefusedFrame(reason = "revoked")))
		listener.onClosed(null, "revoked", null)

		assertEquals(listOf(1_000L), reconnects)
	}

	@Test
	fun socketConstructionFailureUsesCloseBackoff() {
		val coordinator = newCoordinator()
		val reconnects = mutableListOf<Long>()
		val driver = ConsoleSocketDriver(
			coordinator = coordinator,
			newClient = { error("construct") },
			onRows = { _, _ -> },
			reconnect = { reconnects += it },
		)

		driver.connect()

		assertEquals(listOf(1_000L), reconnects)
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

	// Pokes omit payloads.
	@Test
	fun aPokeShapedPlaneDecodesWithoutAPayload() {
		val coordinator = newCoordinator()
		val seen = mutableListOf<Triple<String, Long, Boolean>>()
		val h = harness(coordinator, onPlane = { name, version, payload -> seen += Triple(name, version, payload == null) })
		h.driver.connect()
		h.wireListeners.single().onMessage(h.socket, welcomeJson(cursor = 0L, epoch = 1L, floor = 1L))

		h.wireListeners.single().onMessage(h.socket, """{"type":"plane","incarnation":8,"name":"taskBoard","version":4}""")

		assertEquals(listOf(Triple("taskBoard", 4L, true)), seen)
	}

	@Test
	fun ackAfterTranslationCarriesTheCommittedEpoch() {
		val coordinator = newCoordinator()
		coordinator.setMigrationEpoch(9L)
		val h = harness(coordinator, clientMode = ConsoleSocketMode.INBOX)
		h.driver.connect()
		h.wireListeners.single().onMessage(h.socket, welcomeJson(cursor = 1L, epoch = 4L, floor = 2L, migrationEpoch = 9L))
		assertTrue(h.driver.commitTranslation(1L, 7L, 9L))

		assertEquals(1, h.ackFrames.size)
		assertTrue(h.ackFrames.single().contains("\"cursorEpoch\":9"))
	}

	@Test
	fun planesOnlyWelcomeIgnoresMigrationEpoch() {
		val coordinator = newCoordinator()
		val h = harness(coordinator)
		h.driver.connect()

		h.wireListeners.single().onMessage(h.socket, welcomeJson(cursor = 0L, epoch = 0L, floor = 1L, migrationEpoch = 9L))

		assertEquals(0L, coordinator.migrationEpoch())
		assertFalse(coordinator.awaitingTranslation())
	}

	@Test
	fun planesOnlyWelcomesRunMigrationCallbackAcrossReconnects() {
		val coordinator = newCoordinator()
		var migrations = 0
		val h = harness(coordinator, onWelcome = { _, _ -> migrations++ })
		h.driver.connect()
		h.wireListeners.first().onMessage(h.socket, welcomeJson(cursor = 0L, epoch = 0L, floor = 1L, migrationEpoch = 9L))
		h.driver.connect()
		h.wireListeners.last().onMessage(h.socket, welcomeJson(cursor = 0L, epoch = 0L, floor = 1L, migrationEpoch = 9L))

		assertEquals(2, migrations)
		assertEquals(0L, coordinator.migrationEpoch())
		assertFalse(coordinator.awaitingTranslation())
	}

	@Test
	fun consumerWelcomeBehindEpochAwaitsTranslationAndInvokesMigration() {
		val coordinator = newCoordinator()
		var migrations = 0
		val h = harness(coordinator, clientMode = ConsoleSocketMode.INBOX, onWelcome = { _, _ -> migrations++ })
		h.driver.connect()

		h.wireListeners.single().onMessage(h.socket, welcomeJson(cursor = 11L, epoch = 4L, floor = 12L, migrationEpoch = 9L))

		assertTrue(coordinator.awaitingTranslation())
		assertEquals(9L, coordinator.migrationEpoch())
		assertEquals(1, migrations)
		assertTrue(h.ackFrames.isEmpty())
	}

	@Test
	fun staleWelcomeDoesNotChangeMigrationEpochOrAwaitingState() {
		val coordinator = newCoordinator()
		coordinator.setMigrationEpoch(7L)
		val h = harness(coordinator, clientMode = ConsoleSocketMode.INBOX)
		h.driver.connect()
		h.driver.connect()

		h.wireListeners.first().onMessage(h.socket, welcomeJson(cursor = 0L, epoch = 0L, floor = 1L, migrationEpoch = 9L))

		assertEquals(7L, coordinator.migrationEpoch())
		assertFalse(coordinator.awaitingTranslation())
	}

	private data class Harness(
		val driver: ConsoleSocketDriver,
		val listenerListeners: MutableList<ConsoleSocketListener>,
		val wireListeners: MutableList<WebSocketListener>,
		val socket: WebSocket,
		val closeCalls: IntArray,
		val ackFrames: MutableList<String>,
	)

	private fun harness(
		coordinator: ConsoleTransportCoordinator,
		clientMode: ConsoleSocketMode = ConsoleSocketMode.PLANES,
		onRows: (List<InboxRow>, Long) -> Unit = { _, _ -> },
		onPlane: (String, Long, kotlinx.serialization.json.JsonElement?) -> Unit = { _, _, _ -> },
		onGap: (Long) -> Unit = {},
		onAck: () -> Unit = {},
		kick: () -> Unit = {},
		onUnreachable: () -> Unit = {},
		reconnect: (Long) -> Unit = {},
		onWelcome: (Long, ConsoleWelcomeFrame) -> Unit = { _, _ -> },
	): Harness {
		val listenerListeners = mutableListOf<ConsoleSocketListener>()
		val wireListeners = mutableListOf<WebSocketListener>()
		val closeCalls = intArrayOf(0)
		val ackFrames = mutableListOf<String>()
		val socket = Proxy.newProxyInstance(
			WebSocket::class.java.classLoader,
			arrayOf(WebSocket::class.java),
		) { _, method, args ->
			when (method.name) {
				"send" -> {
					if (args!![0].toString().contains("\"type\":\"ack\"")) {
						ackFrames += args[0].toString()
						onAck()
					}
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
				}.also { it.socketMode = clientMode }
			},
			onRows = onRows,
			onPlane = onPlane,
			onGap = onGap,
			kick = kick,
			onUnreachable = onUnreachable,
			reconnect = reconnect,
			onWelcome = onWelcome,
		)
		return Harness(driver, listenerListeners, wireListeners, socket, closeCalls, ackFrames)
	}

	private fun newCoordinator() = ConsoleTransportCoordinator(
		IdlePushbackManager(FakeStore(), 0L) { java.time.ZoneId.of("UTC") },
	)

	private fun welcomeJson(cursor: Long, epoch: Long, floor: Long, migrationEpoch: Long? = null) =
		"{\"type\":\"welcome\",\"incarnation\":8,\"cursor\":$cursor,\"cursorEpoch\":$epoch,\"floor\":$floor,\"versions\":{}${migrationEpoch?.let { ",\"migrationEpoch\":$it" } ?: ""}}"

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
