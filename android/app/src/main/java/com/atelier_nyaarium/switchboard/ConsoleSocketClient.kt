package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleAckFrame
import com.atelier_nyaarium.switchboard.proto.ConsoleHelloFrame
import com.atelier_nyaarium.switchboard.proto.ConsoleInboxRowsFrame
import com.atelier_nyaarium.switchboard.proto.ConsolePingFrame
import com.atelier_nyaarium.switchboard.proto.ConsolePlaneFrame
import com.atelier_nyaarium.switchboard.proto.ConsolePongFrame
import com.atelier_nyaarium.switchboard.proto.ConsoleRefusedFrame
import com.atelier_nyaarium.switchboard.proto.ConsoleWelcomeFrame
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

internal interface ConsoleSocketScheduler {
	fun schedule(delayMs: Long, task: () -> Unit)
}

internal val defaultConsoleSocketScheduler = object : ConsoleSocketScheduler {
	private val executor = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { task ->
		Thread(task, "console-socket").apply { isDaemon = true }
	}
	override fun schedule(delayMs: Long, task: () -> Unit) {
		executor.schedule(task, delayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
	}
}

internal sealed interface ConsoleSocketFrame {
	data class Welcome(val value: ConsoleWelcomeFrame) : ConsoleSocketFrame
	data class InboxRows(val value: ConsoleInboxRowsFrame) : ConsoleSocketFrame
	data class Plane(val value: ConsolePlaneFrame) : ConsoleSocketFrame
	data class Refused(val value: ConsoleRefusedFrame) : ConsoleSocketFrame
	data class Pong(val value: ConsolePongFrame) : ConsoleSocketFrame
}

internal interface ConsoleSocketListener {
	fun onFrame(frame: ConsoleSocketFrame)
	fun onClosed(code: Int?, reason: String?, cause: Throwable?)
	fun onActivity() = Unit
}

internal class ConsoleSocketClient(
	private val transport: ConsoleSocketTransport,
	private val signHello: () -> OwnerOp?,
	private val listener: ConsoleSocketListener,
	private val openSocket: (OkHttpClient, Request, WebSocketListener) -> WebSocket,
	private val scheduler: ConsoleSocketScheduler,
	private val now: () -> Long,
) {
	private var socket: WebSocket? = null
	private var incarnation: Long? = null
	private var cursorEpoch: Long? = null
	private var closed = false
	private var lastPongAt = 0L
	private var heartbeatArmed = false

	/** Use planes until owner inbox delivery. */
	var mode: String? = "planes"

	constructor(
		transport: ConsoleRelayTransport,
		ownerOps: OwnerOps,
		listener: ConsoleSocketListener,
	) : this(
		transport,
		{ ownerOps.sign(JsonObject(mapOf("kind" to JsonPrimitive("hello")))) },
		listener,
		::newWebSocket,
		defaultConsoleSocketScheduler,
		System::currentTimeMillis,
	)

	constructor(
		transport: ConsoleSocketTransport,
		signHello: () -> OwnerOp?,
		listener: ConsoleSocketListener,
		openSocket: (OkHttpClient, Request, WebSocketListener) -> WebSocket,
	) : this(transport, signHello, listener, openSocket, defaultConsoleSocketScheduler, System::currentTimeMillis)

	fun open(base: String = transport.proxyBase) {
		val uri = java.net.URI(base)
		check(uri.scheme.equals("https", ignoreCase = true)) { "console socket requires an https base" }
		val ownerOp = signHello() ?: error("cannot sign console hello")
		val request = Request.Builder()
			.url("${base.trimEnd('/')}/console")
			.header("X-Console-Bridge-Token", "Bearer ${transport.appToken}")
			.build()
		socket = openSocket(transport.clientFor(base), request, object : WebSocketListener() {
				override fun onOpen(webSocket: WebSocket, response: Response) {
					lastPongAt = now()
					heartbeatArmed = true
					scheduleHeartbeat()
				webSocket.send(
					wireJson.encodeToString(ConsoleHelloFrame.serializer(), ConsoleHelloFrame(ownerOp = ownerOp, mode = mode)),
				)
			}

				override fun onMessage(webSocket: WebSocket, text: String) {
					handle(text)
			}

			override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
				finish(null, null, t)
			}

			override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
				finish(code, reason, null)
			}
		})
	}

	fun ack(cursor: Long) {
		val at = incarnation ?: error("console socket is not welcomed")
		val epoch = cursorEpoch ?: error("console socket is not welcomed")
		socket?.send(wireJson.encodeToString(ConsoleAckFrame.serializer(), ConsoleAckFrame(incarnation = at, cursor = cursor, cursorEpoch = epoch)))
	}

	fun ping() {
		val at = incarnation ?: error("console socket is not welcomed")
		socket?.send(wireJson.encodeToString(ConsolePingFrame.serializer(), ConsolePingFrame(incarnation = at)))
	}

	fun close() {
		heartbeatArmed = false
		socket?.close(1000, "closed")
	}

	private fun scheduleHeartbeat() {
		if (!heartbeatArmed) return
		scheduler.schedule(HEARTBEAT_INTERVAL_MS) {
			if (!heartbeatArmed) return@schedule
			if (now() - lastPongAt >= HEARTBEAT_TIMEOUT_MS) {
				heartbeatArmed = false
				socket?.close(1001, "pong timeout")
			} else {
				runCatching { ping() }
				scheduleHeartbeat()
			}
		}
	}

	private fun handle(text: String) {
		val json = runCatching { wireJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
		when (runCatching { json["type"]?.jsonPrimitive?.content }.getOrNull()) {
			"welcome" -> {
				val frame = wireJson.decodeFromJsonElement(ConsoleWelcomeFrame.serializer(), json)
				if (incarnation == null) {
					incarnation = frame.incarnation
					cursorEpoch = frame.cursorEpoch
					listener.onFrame(ConsoleSocketFrame.Welcome(frame))
				}
			}
			"inbox_rows" -> decodeIfCurrent(json, ConsoleInboxRowsFrame.serializer()) { ConsoleSocketFrame.InboxRows(it) }
			"plane" -> decodeIfCurrent(json, ConsolePlaneFrame.serializer()) { ConsoleSocketFrame.Plane(it) }
			"pong" -> {
				lastPongAt = now()
				decodeIfCurrent(json, ConsolePongFrame.serializer()) { ConsoleSocketFrame.Pong(it) }
			}
			"refused" -> {
				val frame = wireJson.decodeFromJsonElement(ConsoleRefusedFrame.serializer(), json)
				listener.onFrame(ConsoleSocketFrame.Refused(frame))
				close()
			}
		}
	}

	private inline fun <reified T> decodeIfCurrent(
		json: JsonObject,
		serializer: kotlinx.serialization.KSerializer<T>,
		wrap: (T) -> ConsoleSocketFrame,
	) {
		val expected = incarnation ?: return
		val actual = json["incarnation"]?.toString()?.trim('"')?.toLongOrNull() ?: return
		if (actual == expected) listener.onFrame(wrap(wireJson.decodeFromJsonElement(serializer, json)))
	}

	private fun finish(code: Int?, reason: String?, cause: Throwable?) {
		if (closed) return
		closed = true
		listener.onClosed(code, reason, cause)
	}

	private companion object {
		const val HEARTBEAT_INTERVAL_MS = 30_000L
		const val HEARTBEAT_TIMEOUT_MS = 90_000L
		fun newWebSocket(client: OkHttpClient, request: Request, listener: WebSocketListener): WebSocket =
			client.newWebSocket(request, listener)
	}
}
