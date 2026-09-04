package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.board.BoardIntent
import com.atelier_nyaarium.switchboard.board.BoardManager
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter
import com.atelier_nyaarium.switchboard.board.BoardSealing
import com.atelier_nyaarium.switchboard.board.BoardStore
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.KeyGrant
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.crypto.Keyring
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.time.ZoneId
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import okio.Buffer
import okhttp3.Request
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class WireFixtureGenerator {
	@Test
	fun generateOrCheck() {
		val root = load("identity/set.json")
		val out = System.getProperty("wireFixturesOut")?.let(::File)
		val fixtures = listOf(hello(root), keyRequest(root), keyGrant(root), cursorTranslate(root), boardWrite(root)) + consoleOps(root) + transport(root)
		val manifest = buildJsonObject {
			put("_comment", "Kotlin phone wire fixtures.")
			put("fixtures", buildJsonArray { fixtures.forEach { add(it.second) } })
		}
		if (out != null) {
			fixtures.forEach { write(out.resolve(it.first), it.third) }
			write(out.resolve("_manifest.json"), manifest)
		} else {
			val committed = File(System.getProperty("wireFixturesDir") ?: "../../tests/fixtures/wire/kotlin")
			fixtures.forEach { assertEquals(it.first, render(it.third), read(committed.resolve(it.first))) }
			assertEquals("_manifest.json", render(manifest), read(committed.resolve("_manifest.json")))
		}
	}

	private fun load(name: String): JsonObject = javaClass.classLoader?.getResourceAsStream(name)?.bufferedReader()?.use {
		wireJson.parseToJsonElement(it.readText()).jsonObject
	} ?: error("missing fixture: $name")

	private fun hello(root: JsonObject): Triple<String, JsonObject, JsonObject> {
		val case = "hello"
		val opId = "$case-op"
		val nonce = draw(case, 0, 18)
		val consoleNode = root.getValue("console").jsonObject
		val console = wireJson.decodeFromJsonElement<Crypto.Identity>(consoleNode.getValue("identity"))
		val domain = root.getValue("domain").jsonObject
		val tokens = root.getValue("tokens").jsonObject
		val ownerOps = OwnerOps(
			repo = null,
			confirmedDomainId = { domain.getValue("id").jsonPrimitive.content },
			consoleIdentity = { console },
			provisioningConversationId = { consoleNode.getValue("conversationId").jsonPrimitive.content },
			provisioningDevice = { consoleNode.getValue("device").jsonPrimitive.content },
			now = { root.getValue("issuedAt").jsonPrimitive.long },
			newNonce = { nonce },
			newOpId = { opId },
		)
		val op = buildJsonObject { put("kind", "hello") }
		val signed = ownerOps.sign(op, opId) ?: error("hello refused")
		val request = buildOwnerOpRequest("https://router.test", signed, tokens.getValue("console").jsonPrimitive.content)
		val buffer = Buffer()
		request.body!!.writeTo(buffer)
		val json = buildJsonObject {
			put("producer", "kotlin")
			put("composer", "OwnerOps.sign")
			put("case", case)
			put("clock", root.getValue("issuedAt").jsonPrimitive.long)
			put("inputs", buildJsonObject { put("op", op); put("opId", opId); put("nonce", nonce) })
			put("request", buildJsonObject {
				put("method", request.method)
				put("path", request.url.encodedPath)
				put("headers", buildJsonObject { request.headers.names().forEach { put(it.lowercase(), request.header(it)!!) } })
				put("body", buffer.readUtf8())
			})
			put("expect", buildJsonObject { put("outcome", "complete") })
		}
		val manifest = buildJsonObject {
			put("file", "OwnerOps.sign/hello.json")
			put("composer", "OwnerOps.sign")
			put("case", case)
			put("peer", "router.handle")
		}
		return Triple("OwnerOps.sign/hello.json", manifest, json)
	}

	private fun transport(root: JsonObject): List<Triple<String, JsonObject, JsonObject>> {
		val console = root.getValue("console").jsonObject
		val tokens = root.getValue("tokens").jsonObject
		val store = testStore().also {
			it.saveIdentity(wireJson.decodeFromJsonElement<Crypto.Identity>(console.getValue("identity")))
		}
		val client = ConsoleClient(
			Provisioning(
				routerUrl = "https://router.test",
				routerCertFp = "",
				appToken = tokens.getValue("console").jsonPrimitive.content,
				device = console.getValue("device").jsonPrimitive.content,
				conversationId = console.getValue("conversationId").jsonPrimitive.content,
			),
			store,
		)
		val ownerBody = wireJson.parseToJsonElement(hello(root).third.getValue("request").jsonObject.getValue("body").jsonPrimitive.content)
		val ownerOp = wireJson.decodeFromJsonElement<OwnerOp>(ownerBody.jsonObject.getValue("ownerOp"))
		return listOf(
			transportCase("postOwnerOp", "ConsoleRouterTransport.buildOwnerOpRequest", client.transport.buildOwnerOpRequest("https://router.test", ownerOp), expect = "{\"outcome\":\"complete\"}"),
			transportCase("apiReachable", "ConsoleClient.apiReachableRequest", client.apiReachableRequest("https://router.test"), expect = "{\"ok\":true,\"protocolVersion\":2}"),
			transportCase("connectedGateways", "ConsoleClient.connectedGatewaysRequest", client.connectedGatewaysRequest("https://router.test"), expect = "{\"gateways\":[{\"gatewayId\":\"laptop\"}]}"),
			transportCase("reach", "ConsoleClient.reachRequest", client.reachRequest("https://router.test"), expect = "{\"domainId\":\"fixture-domain\"}"),
			transportCase("socketUpgrade", "ConsoleSocketClient.socketRequest", socketRequest("https://router.test", tokens.getValue("console").jsonPrimitive.content), "router.upgrade"),
		)
	}

	private fun keyRequest(root: JsonObject): Triple<String, JsonObject, JsonObject> {
		val identity = consoleIdentity(root)
		val ownerOps = ownerOps(root, "key_request")
		var captured: OwnerOp? = null
		val ops = KeyDeliveryOps(
			{ domain(root) },
			{ error("unused") },
			{ com.atelier_nyaarium.switchboard.crypto.ContentKeyring() },
			{ identity },
			{ op -> captured = ownerOps.sign(op, "key_request-op"); captured },
			{ buildJsonObject {} },
			now = { clock },
			newNonce = { draw("key_request", 1, 18) },
			missingTimer = object : MissingEpochTimer {
				// Retries stay unscheduled.
				override fun schedule(delayMs: Long, task: suspend () -> Unit) {
					if (delayMs == 0L) runBlocking { task() }
				}
			},
		)
		runBlocking { ops.requestMissing(1) }
		return ownerCase(root, "KeyDeliveryOps.requestMissing", "key_request", captured ?: error("key_request not captured"), "key_request-op", "{\"outcome\":\"accepted\"}")
	}

	private fun boardWrite(root: JsonObject): Triple<String, JsonObject, JsonObject> {
		val identity = consoleIdentity(root)
		val domain = domain(root)
		val ring = com.atelier_nyaarium.switchboard.crypto.ContentKeyring().also { it.deriveOwned(identity, domain, 1) }
		val store = object : BoardStore {
			override fun loadTaskBoard(): String? = null
			override fun saveTaskBoard(json: String) = Unit
			override fun loadGatewayId(): String = "fixture-gateway"
		}
		val board = BoardManager(store)
		// Draw 0 is the op nonce.
		var sealDraws = 1
		var captured: OwnerOp? = null
		val ownerOps = ownerOps(root, "board_write")
		val writer = BoardRouterWriter(board, { op, opId ->
			captured = ownerOps.sign(op, opId)
			buildJsonObject {}
		}) { BoardWriteResult(outcome = "applied", revision = 1L, entries = emptyList()) }
		runBlocking {
			writer.write(
				listOf(BoardIntent.Create("fixture-entry", "fixture-title", state = "open", rank = "m")),
				"board_write-op",
				BoardSealing(ring, domain, identity.sign.pub, newNonce = { drawBytes("board_write", sealDraws++, 12) }),
			)
		}
		return ownerCase(root, "BoardRouterWriter.write", "board_write", captured ?: error("board_write not captured"), "board_write-op", "{\"outcome\":\"applied\"}")
	}

	private fun keyGrant(root: JsonObject): Triple<String, JsonObject, JsonObject> {
		val console = consoleIdentity(root)
		val domain = root.getValue("domain").jsonObject
		val key = Base64.getDecoder().decode(root.getValue("content").jsonObject.getValue("key").jsonPrimitive.content)
		val envelope = Crypto.wrapContentKey(key, 1, console.box.pub, domain.getValue("owner").jsonObject.getValue("sign").jsonObject.getValue("pub").jsonPrimitive.content, domain.getValue("owner").jsonObject.getValue("sign").jsonObject.getValue("priv").jsonPrimitive.content)
		var captured: OwnerOp? = null
		val ownerOps = ownerOps(root, "key_receipt")
		val ops = KeyDeliveryOps(
			{ domain(root) },
			{ Keyring(DomainSnapshot(domain.getValue("id").jsonPrimitive.content, emptyList(), emptyList())) },
			{ com.atelier_nyaarium.switchboard.crypto.ContentKeyring(console.box.priv) },
			{ console },
			{ op -> ownerOps.sign(op).also { captured = it } },
			{ buildJsonObject {} },
			install = { _, _ -> KeyDeliveryInstall(true, true) },
			now = { clock },
			newNonce = { draw("key_receipt", 1, 18) },
		)
		runBlocking { ops.onKeyGrant(KeyGrant(1, console.sign.pub, envelope, clock)) }
		return ownerCase(root, "KeyDeliveryOps.onKeyGrant", "key_receipt", captured ?: error("key_receipt not captured"), "key_receipt-op", "{\"outcome\":\"accepted\"}")
	}

	private fun cursorTranslate(root: JsonObject): Triple<String, JsonObject, JsonObject> {
		val coordinator = ConsoleTransportCoordinator(
			IdlePushbackManager(object : IdleSilenceStore {
				override fun loadIdleSilenceStart(): Long? = null
				override fun saveIdleSilenceStart(v: Long) = Unit
			}, clock) { ZoneId.of("UTC") },
		).also {
			it.setMigrationEpoch(9L)
			val generation = it.beginSocket()
			it.onWelcome(generation, 3L, 4L, 0L)
		}
		val journal = MutationJournal(Files.createTempDirectory("wire-cursor").toFile())
		var captured: OwnerOp? = null
		val ownerOps = ownerOps(root, "cursor_translate")
		val ops = CursorTranslationOps(
			coordinator,
			journal,
			{ "owner:domain/owner" },
			{ 4L to 3L },
			{ op, _ -> captured = ownerOps.sign(op, "cursor_translate-op"); captured },
			{ buildJsonObject { put("translation", buildJsonObject { put("kind", "translated"); put("cursor", buildJsonObject { put("epoch", 9L); put("seq", 7L) }) }) } },
			commit = { _, _, _ -> true },
		)
		runBlocking { ops.onWelcome(1L, 9L, welcomeCursor = 11L, welcomeEpoch = 4L) }
		return ownerCase(root, "CursorTranslationOps.onWelcome", "cursor_translate", captured ?: error("cursor_translate not captured"), "cursor_translate-op", "{\"translation\":{\"kind\":\"unmapped\"}}")
	}

	private fun consoleOps(root: JsonObject): List<Triple<String, JsonObject, JsonObject>> {
		val identity = consoleIdentity(root)
		val store = testStore()
		val console = root.getValue("console").jsonObject
		val tokens = root.getValue("tokens").jsonObject
		val client = ConsoleClient(
			Provisioning(appToken = tokens.getValue("console").jsonPrimitive.content, device = console.getValue("device").jsonPrimitive.content, conversationId = console.getValue("conversationId").jsonPrimitive.content),
			store,
			signOwnerOp = { op, opId -> ownerOps(root, opId.removeSuffix("-op")).sign(op, opId).also { lastOwnerOp = it } },
			postOwnerOpSender = { buildJsonObject { put("result", buildJsonObject { put("planes", buildJsonArray {}) }) } },
		)
		return listOf(
			consoleCase(client, captured = { lastOwnerOp = null; client.consumerRegister(1L, "consumer_register-op") }, root, "PollDrain.consumerRegister", "consumer_register", "consumer_register-op", "{\"cursor\":0}"),
			consoleCase(client, captured = { lastOwnerOp = null; client.inboxRead(1L, 0L, opId = "inbox_read-op") }, root, "PollDrain.inboxRead", "inbox_read", "inbox_read-op", "{\"outcome\":\"cursor_stale\"}"),
			consoleCase(client, captured = { lastOwnerOp = null; client.inboxAdvance(0L, 0L, "inbox_advance-op") }, root, "PollDrain.inboxAdvance", "inbox_advance", "inbox_advance-op", "{\"outcome\":\"cursor_stale\"}"),
			consoleCase(client, captured = { lastOwnerOp = null; client.planesRead(buildJsonObject {}, "planes_read-op") }, root, "PollDrain.planesRead", "planes_read", "planes_read-op", "{\"outcome\":\"accepted\"}"),
		)
	}

	private fun consoleCase(
		client: ConsoleClient,
		captured: suspend () -> Any?,
		root: JsonObject,
		composer: String,
		case: String,
		opId: String,
		expect: String,
	): Triple<String, JsonObject, JsonObject> {
		runBlocking { captured() }
		val op = lastOwnerOp ?: error("$case not captured")
		return ownerCase(root, composer, case, op, opId, expect)
	}

	private var lastOwnerOp: OwnerOp? = null
	private val clock: Long = load("identity/set.json").getValue("issuedAt").jsonPrimitive.long

	private fun ownerOps(root: JsonObject, case: String): OwnerOps {
		val console = root.getValue("console").jsonObject
		return OwnerOps(
			repo = null,
			confirmedDomainId = { domain(root) },
			consoleIdentity = { consoleIdentity(root) },
			provisioningConversationId = { console.getValue("conversationId").jsonPrimitive.content },
			provisioningDevice = { console.getValue("device").jsonPrimitive.content },
			now = { root.getValue("issuedAt").jsonPrimitive.long },
			newNonce = { draw(case, 0, 18) },
			newOpId = { "$case-op" },
		)
	}

	private fun ownerCase(
		root: JsonObject,
		composer: String,
		case: String,
		ownerOp: OwnerOp,
		opId: String,
		expect: String,
	): Triple<String, JsonObject, JsonObject> {
		val tokens = root.getValue("tokens").jsonObject
		val request = buildOwnerOpRequest("https://router.test", ownerOp, tokens.getValue("console").jsonPrimitive.content)
		val buffer = Buffer()
		request.body!!.writeTo(buffer)
		val json = buildJsonObject {
			put("producer", "kotlin")
			put("composer", composer)
			put("case", case)
			put("clock", root.getValue("issuedAt").jsonPrimitive.long)
			put("inputs", buildJsonObject { put("op", ownerOp.op); put("opId", opId); put("nonce", ownerOp.nonce) })
			put("request", buildJsonObject {
				put("method", request.method)
				put("path", request.url.encodedPath)
				put("headers", buildJsonObject { request.headers.names().forEach { put(it.lowercase(), request.header(it)!!) } })
				put("body", buffer.readUtf8())
			})
			put("expect", wireJson.parseToJsonElement(expect))
		}
		val manifest = buildJsonObject {
			put("file", "$composer/$case.json")
			put("composer", composer)
			put("case", case)
			put("peer", "router.handle")
		}
		return Triple("$composer/$case.json", manifest, json)
	}

	private fun domain(root: JsonObject): String = root.getValue("domain").jsonObject.getValue("id").jsonPrimitive.content
	private fun consoleIdentity(root: JsonObject): Crypto.Identity = wireJson.decodeFromJsonElement(
		root.getValue("console").jsonObject.getValue("identity"),
	)

	private fun transportCase(
		name: String,
		composer: String,
		request: Request,
		peer: String = "router.handle",
		expect: String = "{}",
	): Triple<String, JsonObject, JsonObject> {
		val buffer = Buffer()
		request.body?.writeTo(buffer)
		val json = buildJsonObject {
			put("producer", "kotlin")
			put("composer", composer)
			put("case", name)
			put("clock", clock)
			put("inputs", buildJsonObject {})
			put("request", buildJsonObject {
				put("method", request.method)
				put("path", request.url.encodedPath)
				put("headers", buildJsonObject { request.headers.names().forEach { put(it.lowercase(), request.header(it)!!) } })
				put("body", buffer.readUtf8())
			})
			put("expect", wireJson.parseToJsonElement(expect))
		}
		val manifest = buildJsonObject {
			put("file", "transport/$name.json")
			put("composer", composer)
			put("case", name)
			put("peer", peer)
		}
		return Triple("transport/$name.json", manifest, json)
	}


	private fun drawBytes(case: String, n: Int, length: Int): ByteArray =
		MessageDigest.getInstance("SHA-256").digest("kotlin:OwnerOps.sign:$case:$n".toByteArray()).copyOf(length)

	private fun draw(case: String, n: Int, length: Int): String = Base64.getEncoder().encodeToString(drawBytes(case, n, length))

	private fun render(value: JsonObject): String = Json(from = wireJson) { prettyPrint = true; prettyPrintIndent = "\t" }
		.encodeToString(JsonObject.serializer(), value) + "\n"
	private fun read(file: File): String = file.takeIf(File::exists)?.readText() ?: ""
	private fun write(file: File, value: JsonObject) {
		file.parentFile.mkdirs()
		file.writeText(render(value))
	}
}
