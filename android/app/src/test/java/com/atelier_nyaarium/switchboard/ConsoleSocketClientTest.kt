package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.OwnerOp
import java.lang.reflect.Proxy
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConsoleSocketClientTest {
	private class Transport(override val proxyBase: String = "https://router", override val appToken: String = "token") : ConsoleSocketTransport {
		override fun clientFor(base: String) = OkHttpClient()
	}

	private class Events : ConsoleSocketListener {
		val frames = mutableListOf<ConsoleSocketFrame>()
		var closed = false
		override fun onFrame(frame: ConsoleSocketFrame) {
			frames += frame
		}
		override fun onClosed(code: Int?, reason: String?, cause: Throwable?) {
			closed = true
		}
	}

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

	private fun fakeSocket(): WebSocket = Proxy.newProxyInstance(
		WebSocket::class.java.classLoader,
		arrayOf(WebSocket::class.java),
	) { _, method, _ ->
		when (method.name) {
			"send", "close", "cancel" -> true
			"request" -> Request.Builder().url("https://router/console").build()
			"queueSize" -> 0L
			"toString" -> "fake"
			else -> null
		}
	} as WebSocket

	private data class Harness(
		val client: ConsoleSocketClient,
		val listener: WebSocketListener,
		val sent: MutableList<String>,
		/** Socket handed to listener. */
		val socket: WebSocket,
	)

	private fun harness(): Harness {
		val events = Events()
		var listener: WebSocketListener? = null
		val sent = mutableListOf<String>()
		val socket = Proxy.newProxyInstance(
			WebSocket::class.java.classLoader,
			arrayOf(WebSocket::class.java),
		) { _, method, args ->
			when (method.name) {
				"send" -> {
					sent += args!![0].toString()
					true
				}
				"close", "cancel" -> true
				"request" -> Request.Builder().url("https://router/console").build()
				"queueSize" -> 0L
				"toString" -> "fake"
				else -> null
			}
		} as WebSocket
		val client = ConsoleSocketClient(
			Transport(),
			::ownerOp,
			events,
		) { _, _, socketListener ->
			listener = socketListener
			socket
		}
		client.open()
		return Harness(client, listener!!, sent, socket)
	}

	private fun response() = Response.Builder()
		.request(Request.Builder().url("https://router/console").build())
		.protocol(okhttp3.Protocol.HTTP_1_1)
		.code(101)
		.message("")
		.build()

	@Test
	fun helloIsFirstAndSigned() {
		val h = harness()
		h.listener.onOpen(h.socket, response())
		assertEquals(1, h.sent.size)
		assertTrue(h.sent.first().contains("\"type\":\"hello\""))
		assertTrue(h.sent.first().contains("\"signature\":\"signed\""))
	}

	@Test
	fun differentIncarnationIsIgnoredAndAckUsesBoundIncarnation() {
		val h = harness()
		h.listener.onOpen(h.socket, response())
		h.listener.onMessage(fakeSocket(), """{"type":"welcome","incarnation":7,"cursor":2,"cursorEpoch":3,"floor":0,"versions":{}}""")
		h.client.ack(19)
		assertTrue(h.sent.last().contains("\"incarnation\":7"))
		assertTrue(h.sent.last().contains("\"cursor\":19"))
		val before = h.sent.size
		h.listener.onMessage(fakeSocket(), """{"type":"pong","incarnation":8}""")
		assertEquals(before, h.sent.size)
	}

	@Test
	fun refusedCursorStaleSurfacesGapAndCloses() {
		val events = Events()
		var listener: WebSocketListener? = null
		val socket = fakeSocket()
		val client = ConsoleSocketClient(Transport(), ::ownerOp, events) { _, _, socketListener ->
			listener = socketListener
			socket
		}
		client.open()
		listener!!.onMessage(socket, """{"type":"refused","reason":"cursor_stale","floor":12,"dropped":4}""")
		val refused = events.frames.single() as ConsoleSocketFrame.Refused
		assertEquals("cursor_stale", refused.value.reason)
		assertEquals(12L, refused.value.floor)
		assertEquals(4L, refused.value.dropped)
	}

	@Test
	fun nonHttpsBaseDoesNotOpenSocket() {
		var opened = false
		val client = ConsoleSocketClient(Transport(), ::ownerOp, Events()) { _, _, _ ->
			opened = true
			fakeSocket()
		}
		try {
			client.open("http://router")
		} catch (_: IllegalStateException) {
		}
		assertFalse(opened)
	}
}
