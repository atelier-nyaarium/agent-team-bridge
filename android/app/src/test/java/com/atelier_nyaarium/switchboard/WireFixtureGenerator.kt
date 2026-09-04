package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.board.BoardIntent
import com.atelier_nyaarium.switchboard.board.BoardManager
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter
import com.atelier_nyaarium.switchboard.board.BoardSealing
import com.atelier_nyaarium.switchboard.board.BoardStore
import com.atelier_nyaarium.switchboard.proto.BoardReadResult
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.EnabledPlugin
import com.atelier_nyaarium.switchboard.proto.KeyGrant
import com.atelier_nyaarium.switchboard.proto.KeyRequest
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.WireFixture
import com.atelier_nyaarium.switchboard.proto.WireFixtureEntry
import com.atelier_nyaarium.switchboard.proto.WireManifest
import com.atelier_nyaarium.switchboard.proto.WireRequest
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Keyring
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.time.ZoneId
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
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
	private typealias Fixture = Triple<String, WireFixtureEntry, WireFixture>

	@Test
	fun generateOrCheck() {
		val root = load("identity/set.json")
		val out = System.getProperty("wireFixturesOut")?.let(::File)
		val fixtures = listOf(hello(root), keyRequest(root), keyGrant(root), cursorTranslate(root), boardWrite(root), boardRead(root)) +
			listOf(deliver(root), gatewayValue(root), keyGrantCase(root), reportRead(root), capabilities(root)) + consoleOps(root) + transport(root)
		val manifest = WireManifest("Kotlin phone wire fixtures.", fixtures.map { it.second })
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

	private fun hello(root: JsonObject): Fixture {
		val case = "hello"
		val opId = "$case-op"
		val op = buildJsonObject { put("kind", "hello") }
		val signed = ownerOps(root, "OwnerOps.sign", case).sign(op, opId) ?: error("hello refused")
		return ownerCase(root, "OwnerOps.sign", case, signed, opId, "{\"outcome\":\"complete\"}")
	}

	private fun transport(root: JsonObject): List<Fixture> {
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
		val ownerBody = wireJson.parseToJsonElement((hello(root).third as WireFixture.Kotlin).request.body)
		val ownerOp = wireJson.decodeFromJsonElement<OwnerOp>(ownerBody.jsonObject.getValue("ownerOp"))
		return listOf(
			transportCase("postOwnerOp", "ConsoleRouterTransport.buildOwnerOpRequest", client.transport.buildOwnerOpRequest("https://router.test", ownerOp), expect = "{\"outcome\":\"complete\"}"),
			transportCase("apiReachable", "ConsoleClient.buildHealthRequest", client.buildHealthRequest("https://router.test"), expect = "{\"ok\":true,\"protocolVersion\":2}"),
			transportCase("connectedGateways", "ConsoleClient.buildConnectedGatewaysRequest", client.buildConnectedGatewaysRequest("https://router.test"), expect = "{\"gateways\":[{\"gatewayId\":\"laptop\"}]}"),
			transportCase("reach", "ConsoleClient.buildReachRequest", client.buildReachRequest("https://router.test"), expect = "{\"domainId\":\"fixture-domain\"}"),
			transportCase("socketUpgrade", "ConsoleSocketClient.buildSocketRequest", buildSocketRequest("https://router.test", tokens.getValue("console").jsonPrimitive.content), "router.upgrade"),
		)
	}

	private fun keyRequest(root: JsonObject): Fixture {
		val identity = consoleIdentity(root)
		val ownerOps = ownerOps(root, "KeyDeliveryOps.requestMissing", "key_request")
		var captured: OwnerOp? = null
		val ops = KeyDeliveryOps(
			domainId = { domain(root) },
			keyring = { error("unused") },
			contentKeyring = { ContentKeyring() },
			consoleIdentity = { identity },
			signOwnerOp = { op -> captured = ownerOps.sign(op, "key_request-op"); captured },
			sendOwnerOp = { buildJsonObject {} },
			now = { clock },
			newNonce = { draw("KeyDeliveryOps.requestMissing", "key_request", 1, 18) },
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

	private fun boardWrite(root: JsonObject): Fixture {
		val domain = domain(root)
		val ring = ContentKeyring().also { it.deriveOwned(ownerIdentity(root), domain, 1) }
		val board = BoardManager(fixtureBoard())
		// Draw 0 is the op nonce.
		var sealDraws = 1
		var captured: OwnerOp? = null
		val ownerOps = ownerOps(root, "BoardRouterWriter.write", "board_write")
		val writer = BoardRouterWriter(board, { op, opId ->
			captured = ownerOps.sign(op, opId)
			buildJsonObject {}
		}) { BoardWriteResult(outcome = "applied", revision = 1L, entries = emptyList()) }
		runBlocking {
			writer.write(
				listOf(BoardIntent.Create("fixture-entry", "fixture-title", state = "open", rank = "m")),
				"board_write-op",
				BoardSealing(ring, domain, ownerIdentity(root).sign.pub, newNonce = { drawBytes("BoardRouterWriter.write", "board_write", sealDraws++, 12) }),
			)
		}
		return ownerCase(root, "BoardRouterWriter.write", "board_write", captured ?: error("board_write not captured"), "board_write-op", "{\"outcome\":\"applied\"}")
	}

	private fun boardRead(root: JsonObject): Fixture {
		val board = BoardManager(fixtureBoard())
		var captured: OwnerOp? = null
		val ownerOps = ownerOps(root, "BoardRouterWriter.read", "board_read")
		val writer = BoardRouterWriter(board, { op, opId ->
			captured = ownerOps.sign(op, opId)
			buildJsonObject { put("revision", 0L); put("entries", buildJsonArray {}) }
		}) { BoardWriteResult(outcome = "applied", revision = 0L, entries = emptyList()) }
		runBlocking { writer.read("board_read-op") { result -> wireJson.decodeFromJsonElement<BoardReadResult>(result) } }
		return ownerCase(root, "BoardRouterWriter.read", "board_read", captured ?: error("board_read not captured"), "board_read-op", "{\"revision\":1,\"entries\":[{\"clear\":{\"id\":\"fixture-entry\",\"state\":\"open\",\"rank\":\"m\",\"version\":1}}]}")
	}

	private fun keyGrant(root: JsonObject): Fixture {
		val console = consoleIdentity(root)
		val domain = root.getValue("domain").jsonObject
		val key = Base64.getDecoder().decode(root.getValue("content").jsonObject.getValue("key").jsonPrimitive.content)
		val envelope = Crypto.wrapContentKey(key, 1, console.box.pub, domain.getValue("owner").jsonObject.getValue("sign").jsonObject.getValue("pub").jsonPrimitive.content, domain.getValue("owner").jsonObject.getValue("sign").jsonObject.getValue("priv").jsonPrimitive.content)
		var captured: OwnerOp? = null
		val ownerOps = ownerOps(root, "KeyDeliveryOps.onKeyGrant", "key_receipt")
		val ownerSignPub = domain.getValue("owner").jsonObject.getValue("sign").jsonObject.getValue("pub").jsonPrimitive.content
		val ops = KeyDeliveryOps(
			domainId = { domain(root) },
			keyring = { Keyring(DomainSnapshot(ownerSignPub, emptyList(), emptyList())) },
			contentKeyring = { ContentKeyring(console.box.priv) },
			consoleIdentity = { console },
			signOwnerOp = { op -> ownerOps.sign(op).also { captured = it } },
			sendOwnerOp = { buildJsonObject {} },
			install = { _, _ -> KeyDeliveryInstall(true, true) },
			now = { clock },
			newNonce = { draw("KeyDeliveryOps.onKeyGrant", "key_receipt", 1, 18) },
		)
		runBlocking { ops.onKeyGrant(KeyGrant(1, console.sign.pub, envelope, clock)) }
		return ownerCase(root, "KeyDeliveryOps.onKeyGrant", "key_receipt", captured ?: error("key_receipt not captured"), "key_receipt-op", "{\"outcome\":\"accepted\"}")
	}

	private fun cursorTranslate(root: JsonObject): Fixture {
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
		val ownerOps = ownerOps(root, "CursorTranslationOps.onWelcome", "cursor_translate")
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

	private fun deliver(root: JsonObject): Fixture {
		val case = "deliver"
		val opId = "$case-op"
		val nonce = draw("ConsoleClient.send", case, 0, 18)
		val sealNonce = drawBytes("ConsoleClient.send", case, 1, 12)
		val console = root.getValue("console").jsonObject
		val tokens = root.getValue("tokens").jsonObject
		val identity = consoleIdentity(root)
		val domain = domain(root)
		val ring = ContentKeyring().also { it.deriveOwned(ownerIdentity(root), domain, 1) }
		val store = testStore().also { it.saveIdentity(identity) }
		var captured: OwnerOp? = null
		val client = ConsoleClient(
			Provisioning(
				appToken = tokens.getValue("console").jsonPrimitive.content,
				device = console.getValue("device").jsonPrimitive.content,
				conversationId = console.getValue("conversationId").jsonPrimitive.content,
			),
			store,
			signOwnerOp = { op, id -> ownerOps(root, "ConsoleClient.send", case).sign(op, id).also { captured = it } },
			domainId = { domain },
			ownerSignPub = { ownerIdentity(root).sign.pub },
			homeGatewayId = { root.getValue("gateway").jsonObject.getValue("id").jsonPrimitive.content },
			contentKeyring = { ring },
			postOwnerOpSender = { buildJsonObject { put("ok", true) } },
			sealNonce = { sealNonce },
		)
		val rec = ScheduledSend("fixture delivery", emptyList(), clock, opId, null, clock)
		val plan = composeScheduledSend(rec, clock)
		runBlocking { client.send("fixture-domain.laptop.fixture-app.abc123", plan.text, emptyList(), plan.opId, plan.targetDomainId) }
		return ownerCase(
			root,
			"ConsoleClient.send",
			case,
			captured ?: error("deliver not captured"),
			opId,
			"{\"outcome\":\"accepted\"}",
			buildJsonObject {
				put("op", captured!!.op)
				put("opId", opId)
				put("nonce", nonce)
				put("sealNonce", draw("ConsoleClient.send", case, 1, 12))
				put("record", buildJsonObject {
					put("text", rec.text)
					put("fileRefs", buildJsonArray {})
					put("fireAtMillis", rec.fireAtMillis)
					put("opId", rec.opId)
					put("targetDomainId", JsonNull)
					put("createdAt", rec.createdAt)
				})
				put("team", "fixture-domain.laptop.fixture-app.abc123")
			},
		)
	}

	private fun gatewayValue(root: JsonObject): Fixture {
		val case = "gateway_value"
		val opId = "gateway_value-op"
		val nonce = draw("ConsoleClient.sendValueOp", case, 0, 18)
		val sealNonce = drawBytes("ConsoleClient.sendValueOp", case, 1, 12)
		val console = root.getValue("console").jsonObject
		val tokens = root.getValue("tokens").jsonObject
		val identity = consoleIdentity(root)
		val domain = domain(root)
		val ring = ContentKeyring().also { it.deriveOwned(ownerIdentity(root), domain, 1) }
		val store = testStore().also { it.saveIdentity(identity) }
		var captured: OwnerOp? = null
		val target = "fixture-domain.laptop.fixture-app.abc123"
		val client = ConsoleClient(
			Provisioning(
				appToken = tokens.getValue("console").jsonPrimitive.content,
				device = console.getValue("device").jsonPrimitive.content,
				conversationId = console.getValue("conversationId").jsonPrimitive.content,
			),
			store,
			signOwnerOp = { op, id -> ownerOps(root, "ConsoleClient.sendValueOp", case).sign(op, id).also { captured = it } },
			domainId = { domain },
			ownerSignPub = { ownerIdentity(root).sign.pub },
			homeGatewayId = { root.getValue("gateway").jsonObject.getValue("id").jsonPrimitive.content },
			contentKeyring = { ring },
			postOwnerOpSender = { buildJsonObject { put("outcome", "accepted") } },
			sealNonce = { sealNonce },
		)
		runBlocking { client.sendValueOp("laptop", ConsoleOp.Peek(target = target), opId) }
		return ownerCase(
			root,
			"ConsoleClient.sendValueOp",
			case,
			captured ?: error("gateway_value not captured"),
			opId,
			"{\"outcome\":\"accepted\"}",
			buildJsonObject {
				put("op", captured!!.op)
				put("opId", opId)
				put("nonce", nonce)
				put("sealNonce", draw("ConsoleClient.sendValueOp", case, 1, 12))
				put("gatewayId", "laptop")
				put("target", target)
			},
		)
	}

	private fun keyGrantCase(root: JsonObject): Fixture {
		val case = "key_grant"
		val identity = consoleIdentity(root)
		val gateway = wireJson.decodeFromJsonElement<Crypto.Identity>(root.getValue("gateway").jsonObject.getValue("identity"))
		val gatewayAdmission = wireJson.decodeFromJsonElement<SignedAdmission>(root.getValue("gateway").jsonObject.getValue("admission"))
		val snapshot = DomainSnapshot(root.getValue("domain").jsonObject.getValue("owner").jsonObject.getValue("sign").jsonObject.getValue("pub").jsonPrimitive.content, listOf(gatewayAdmission), emptyList())
		val ring = ContentKeyring().also { it.deriveOwned(ownerIdentity(root), domain(root), 1) }
		val ownerOps = ownerOps(root, "KeyDeliveryOps.onKeyRequest", case)
		var captured: OwnerOp? = null
		val requestNonce = "fixture-gateway-request"
		val epochs = listOf(1L)
		val request = KeyRequest(
			1,
			domain(root),
			gateway.sign.pub,
			epochs,
			clock,
			requestNonce,
			Crypto.sign(Crypto.keyRequestSigningBytes(domain(root), gateway.sign.pub, epochs, clock, requestNonce), gateway.sign.priv),
		)
		// Draw 0 is the op nonce.
		var wrapDraws = 1
		val ops = KeyDeliveryOps(
			domainId = { domain(root) },
			keyring = { Keyring(snapshot) },
			contentKeyring = { ring },
			consoleIdentity = { identity },
			signOwnerOp = { op -> ownerOps.sign(op, "key_grant-op").also { captured = it } },
			sendOwnerOp = { buildJsonObject { put("outcome", "accepted") } },
			now = { clock },
			wrapEntropy = { size -> drawBytes("KeyDeliveryOps.onKeyRequest", case, wrapDraws++, size) },
		)
		runBlocking { ops.onKeyRequest(request) }
		return ownerCase(
			root,
			"KeyDeliveryOps.onKeyRequest",
			case,
			captured ?: error("key_grant not captured"),
			"key_grant-op",
			"{\"outcome\":\"accepted\"}",
			buildJsonObject {
				put("op", captured!!.op)
				put("opId", "key_grant-op")
				put("nonce", captured!!.nonce)
				put("request", wireJson.encodeToJsonElement(KeyRequest.serializer(), request))
				put("entropy", buildJsonArray { add(draw("KeyDeliveryOps.onKeyRequest", case, 1, 32)); add(draw("KeyDeliveryOps.onKeyRequest", case, 2, 12)) })
			},
		)
	}

	private fun reportRead(root: JsonObject): Fixture {
		val case = "report_read"
		val op = ownerOps(root, "composeReportRead", case).sign(composeReportRead("fixture-domain.laptop.fixture-app.abc123", ReadAnchor(1, 1, clock), clock), "$case-op")
		return ownerCase(root, "composeReportRead", case, op ?: error("report_read refused"), "$case-op", "{\"outcome\":\"accepted\",\"advanced\":true}")
	}

	private fun capabilities(root: JsonObject): Fixture {
		val case = "capabilities"
		val op = ownerOps(root, "composeCapabilitiesReport", case).sign(composeCapabilitiesReport(listOf(EnabledPlugin("designer"))), "$case-op")
		return ownerCase(root, "composeCapabilitiesReport", case, op ?: error("capabilities refused"), "$case-op", "{\"known\":true,\"capabilities\":[{\"id\":\"designer\"}],\"clientVersions\":[],\"outcome\":\"accepted\"}")
	}

	private fun consoleOps(root: JsonObject): List<Fixture> {
		val identity = consoleIdentity(root)
		val store = testStore()
		val console = root.getValue("console").jsonObject
		val tokens = root.getValue("tokens").jsonObject
		val client = ConsoleClient(
			Provisioning(appToken = tokens.getValue("console").jsonPrimitive.content, device = console.getValue("device").jsonPrimitive.content, conversationId = console.getValue("conversationId").jsonPrimitive.content),
			store,
			signOwnerOp = { op, opId -> ownerOps(root, consoleComposers.getValue(opId.removeSuffix("-op")), opId.removeSuffix("-op")).sign(op, opId).also { lastOwnerOp = it } },
			postOwnerOpSender = { buildJsonObject { put("result", buildJsonObject { put("planes", buildJsonArray {}) }) } },
		)
		return listOf(
			consoleCase(client, captured = { lastOwnerOp = null; client.consumerRegister(1L, "consumer_register-op") }, root, "ConsoleClient.consumerRegister", "consumer_register", "consumer_register-op", "{\"cursor\":0}"),
			consoleCase(client, captured = { lastOwnerOp = null; client.inboxRead(1L, 0L, opId = "inbox_read-op") }, root, "ConsoleClient.inboxRead", "inbox_read", "inbox_read-op", "{\"outcome\":\"cursor_stale\"}"),
			consoleCase(client, captured = { lastOwnerOp = null; client.inboxAdvance(0L, 0L, "inbox_advance-op") }, root, "ConsoleClient.inboxAdvance", "inbox_advance", "inbox_advance-op", "{\"outcome\":\"cursor_stale\"}"),
			consoleCase(client, captured = { lastOwnerOp = null; client.planesRead(buildJsonObject {}, "planes_read-op") }, root, "ConsoleClient.planesRead", "planes_read", "planes_read-op", "{\"outcome\":\"accepted\"}"),
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
	): Fixture {
		runBlocking { captured() }
		val op = lastOwnerOp ?: error("$case not captured")
		return ownerCase(root, composer, case, op, opId, expect)
	}

	private var lastOwnerOp: OwnerOp? = null
	private val consoleComposers = mapOf(
		"consumer_register" to "ConsoleClient.consumerRegister",
		"inbox_read" to "ConsoleClient.inboxRead",
		"inbox_advance" to "ConsoleClient.inboxAdvance",
		"planes_read" to "ConsoleClient.planesRead",
	)
	private val clock: Long = load("identity/set.json").getValue("issuedAt").jsonPrimitive.long

	private fun ownerOps(root: JsonObject, composer: String, case: String): OwnerOps {
		val console = root.getValue("console").jsonObject
		return OwnerOps(
			confirmedDomainId = { domain(root) },
			consoleIdentity = { consoleIdentity(root) },
			provisioningConversationId = { console.getValue("conversationId").jsonPrimitive.content },
			provisioningDevice = { console.getValue("device").jsonPrimitive.content },
			now = { root.getValue("issuedAt").jsonPrimitive.long },
			newNonce = { draw(composer, case, 0, 18) },
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
		inputs: JsonObject? = null,
	): Fixture {
		val tokens = root.getValue("tokens").jsonObject
		val request = buildOwnerOpRequest("https://router.test", ownerOp, tokens.getValue("console").jsonPrimitive.content)
		val buffer = Buffer()
		request.body!!.writeTo(buffer)
		val body = buffer.readUtf8()
		val headers = buildJsonObject { request.headers.names().forEach { put(it.lowercase(), request.header(it)!!) } }
		val fixture = WireFixture.Kotlin(
			composer = composer,
			case = case,
			clock = root.getValue("issuedAt").jsonPrimitive.long,
			inputs = inputs ?: buildJsonObject { put("op", ownerOp.op); put("opId", opId); put("nonce", ownerOp.nonce) },
			expect = wireJson.parseToJsonElement(expect).jsonObject,
			request = WireRequest(request.method, request.url.encodedPath, headers, body),
		)
		val manifest = WireFixtureEntry("$composer/$case.json", composer, case, "router.handle")
		return Triple("$composer/$case.json", manifest, fixture)
	}

	private fun domain(root: JsonObject): String = root.getValue("domain").jsonObject.getValue("id").jsonPrimitive.content
	private fun fixtureBoard(): BoardStore = object : BoardStore {
		override fun loadTaskBoard(): String? = null
		override fun saveTaskBoard(json: String) = Unit
		override fun loadGatewayId(): String = "fixture-gateway"
	}
	private fun ownerIdentity(root: JsonObject): Crypto.Identity =
		wireJson.decodeFromJsonElement(root.getValue("domain").jsonObject.getValue("owner"))
	private fun consoleIdentity(root: JsonObject): Crypto.Identity = wireJson.decodeFromJsonElement(
		root.getValue("console").jsonObject.getValue("identity"),
	)

	private fun transportCase(
		name: String,
		composer: String,
		request: Request,
		peer: String = "router.handle",
		expect: String = "{}",
	): Fixture {
		val buffer = Buffer()
		request.body?.writeTo(buffer)
		val headers = buildJsonObject { request.headers.names().forEach { put(it.lowercase(), request.header(it)!!) } }
		val fixture = WireFixture.Kotlin(
			composer = composer,
			case = name,
			clock = clock,
			inputs = buildJsonObject {},
			expect = wireJson.parseToJsonElement(expect).jsonObject,
			request = WireRequest(request.method, request.url.encodedPath, headers, buffer.readUtf8()),
		)
		val manifest = WireFixtureEntry("transport/$name.json", composer, name, peer)
		return Triple("transport/$name.json", manifest, fixture)
	}

	private fun write(file: File, value: WireFixture) {
		file.parentFile.mkdirs()
		file.writeText(render(value))
	}

	private fun write(file: File, value: WireManifest) {
		file.parentFile.mkdirs()
		file.writeText(render(value))
	}

	private fun drawBytes(composer: String, case: String, n: Int, length: Int): ByteArray =
		MessageDigest.getInstance("SHA-256").digest("kotlin:$composer:$case:$n".toByteArray()).copyOf(length)

	private fun draw(composer: String, case: String, n: Int, length: Int): String = Base64.getEncoder().encodeToString(drawBytes(composer, case, n, length))

	private fun render(value: WireFixture): String = Json(from = wireJson) { prettyPrint = true; prettyPrintIndent = "\t" }
		.encodeToString(WireFixture.serializer(), value) + "\n"
	private fun render(value: WireManifest): String = Json(from = wireJson) { prettyPrint = true; prettyPrintIndent = "\t" }
		.encodeToString(WireManifest.serializer(), value) + "\n"
	private fun read(file: File): String = file.takeIf(File::exists)?.readText() ?: ""
}
