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
}

internal class ConsoleSocketClient(
	private val transport: ConsoleSocketTransport,
	private val signHello: () -> OwnerOp?,
	private val listener: ConsoleSocketListener,
	private val openSocket: (OkHttpClient, Request, WebSocketListener) -> WebSocket,
) {
	private var socket: WebSocket? = null
	private var incarnation: Long? = null
	private var cursorEpoch: Long? = null
	private var closed = false

	/** Planes only until the Router's owner inbox carries this device's messages. Reading it before
	 * then would pin the compaction floor at a cursor nothing advances. */
	var mode: String? = "planes"

	constructor(
		transport: ConsoleRelayTransport,
		ownerOps: OwnerOps,
		listener: ConsoleSocketListener,
	) : this(transport, { ownerOps.sign(JsonObject(mapOf("kind" to JsonPrimitive("hello")))) }, listener, ::newWebSocket)

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
		socket?.close(1000, "closed")
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
			"pong" -> decodeIfCurrent(json, ConsolePongFrame.serializer()) { ConsoleSocketFrame.Pong(it) }
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
		fun newWebSocket(client: OkHttpClient, request: Request, listener: WebSocketListener): WebSocket =
			client.newWebSocket(request, listener)
	}
}
