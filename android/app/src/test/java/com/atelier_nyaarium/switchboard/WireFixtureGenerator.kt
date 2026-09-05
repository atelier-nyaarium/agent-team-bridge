package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.board.BoardIntent
import com.atelier_nyaarium.switchboard.board.BoardManager
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter
import com.atelier_nyaarium.switchboard.board.BoardSealing
import com.atelier_nyaarium.switchboard.board.BoardStore
import com.atelier_nyaarium.switchboard.crypto.VAULT_PUBLIC_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_VALUE_KIND
import com.atelier_nyaarium.switchboard.proto.BoardReadResult
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.EnabledPlugin
import com.atelier_nyaarium.switchboard.proto.KeyGrant
import com.atelier_nyaarium.switchboard.proto.KeyRequest
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.VaultEntrySealed
import com.atelier_nyaarium.switchboard.proto.VaultPut
import com.atelier_nyaarium.switchboard.vault.VaultRouterWriter
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import com.atelier_nyaarium.switchboard.proto.WireFixture
import com.atelier_nyaarium.switchboard.proto.WireFixtureEntry
import com.atelier_nyaarium.switchboard.proto.WireManifest
import com.atelier_nyaarium.switchboard.proto.WireRequest
import com.atelier_nyaarium.switchboard.proto.WireSealed
import java.io.File
import java.nio.file.Files
import java.time.ZoneId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okio.Buffer
import okhttp3.Request
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class WireFixtureGenerator {
	private typealias Fixture = Triple<String, WireFixtureEntry, WireFixture>
	private val world by lazy { FixtureWorld.from(load("identity/set.json")) }

	@Test
	fun generateOrCheck() {
		val root = load("identity/set.json")
		val out = System.getProperty("wireFixturesOut")?.let(::File)
		val fixtures = listOf(hello(root), keyRequest(root), keyGrant(root), cursorTranslate(root), boardWrite(root), boardRead(root)) +
			listOf(vaultPut(root), vaultList(root)) +
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
		val draws = FixtureDraws.forCase("OwnerOps.sign", case)
		val opId = "$case-op"
		val op = buildJsonObject { put("kind", "hello") }
		val signed = OwnerOps(world.bootstrap(), world.ambient(draws)).sign(op, opId)
		return ownerCase(root, "OwnerOps.sign", case, signed, opId, "{\"outcome\":\"complete\"}", draws = draws)
	}

	private fun transport(root: JsonObject): List<Fixture> {
		val client = world.client(FixtureDraws.forCase("ConsoleClient.transport", "transport"))
		val ownerBody = wireJson.parseToJsonElement((hello(root).third as WireFixture.Kotlin).request.body)
		val ownerOp = wireJson.decodeFromJsonElement<OwnerOp>(ownerBody.jsonObject.getValue("ownerOp"))
		return listOf(
			transportCase("postOwnerOp", "ConsoleRouterTransport.buildOwnerOpRequest", client.transport.buildOwnerOpRequest("https://router.test", ownerOp), expect = "{\"outcome\":\"complete\"}"),
			transportCase("apiReachable", "ConsoleRouterTransport.buildHealthRequest", client.transport.buildHealthRequest("https://router.test"), expect = "{\"ok\":true,\"protocolVersion\":2}"),
			transportCase("connectedGateways", "ConsoleClient.buildConnectedGatewaysRequest", client.buildConnectedGatewaysRequest("https://router.test"), expect = "{\"gateways\":[{\"gatewayId\":\"laptop\"}]}"),
			transportCase("reach", "ConsoleRouterTransport.buildReachRequest", client.transport.buildReachRequest("https://router.test"), expect = "{\"domainId\":\"fixture-domain\"}"),
			transportCase("socketUpgrade", "ConsoleSocketClient.buildSocketRequest", buildSocketRequest("https://router.test", world.consoleToken), "router.upgrade"),
		)
	}

	private fun keyRequest(root: JsonObject): Fixture {
		val draws = FixtureDraws.forCase("KeyDeliveryOps.requestMissing", "key_request")
		val boot = world.bootstrap()
		val ambient = world.ambient(draws)
		val ownerOps = OwnerOps(boot, ambient)
		var captured: OwnerOp? = null
		val ops = KeyDeliveryOps(
			boot,
			ambient,
			KeyDeliveryCollaborators(
				signOwnerOp = { op -> ownerOps.sign(op, "key_request-op").also { captured = it } },
				sendOwnerOp = { buildJsonObject {} },
				install = { _, _ -> KeyDeliveryInstall(true, true) },
				reportError = {},
			),
		)
		runBlocking { ops.requestMissing(1) }
		return ownerCase(root, "KeyDeliveryOps.requestMissing", "key_request", captured!!, "key_request-op", "{\"outcome\":\"accepted\"}", draws = draws)
	}

	private fun boardWrite(root: JsonObject): Fixture {
		val draws = FixtureDraws.forCase("BoardRouterWriter.write", "board_write")
		val board = BoardManager(fixtureBoard())
		val boot = world.bootstrap()
		val ambient = world.ambient(draws)
		var captured: OwnerOp? = null
		val ownerOps = OwnerOps(boot, ambient)
		val writer = BoardRouterWriter(board, { op, opId ->
			captured = ownerOps.sign(op, opId)
			buildJsonObject {}
		}) { BoardWriteResult(outcome = "applied", revision = 1L, entries = emptyList()) }
		runBlocking {
			writer.write(
				listOf(BoardIntent.Create("fixture-entry", "fixture-title", state = "open", rank = "m")),
				"board_write-op",
				BoardSealing(boot, ambient) {},
			)
		}
		val op = checkNotNull(captured)
		return ownerCase(
			root,
			"BoardRouterWriter.write",
			"board_write",
			op,
			"board_write-op",
			"{\"outcome\":\"applied\"}",
			buildJsonObject {
				put("op", op.op)
				put("opId", "board_write-op")
				put("nonce", op.nonce)
				put("title", "fixture-title")
			},
			draws = draws,
			sealed = listOf(WireSealed(path = "write.ops[0].title", aadKind = "board.title\nfixture-entry", plaintextOf = "title")),
		)
	}

	private fun boardRead(root: JsonObject): Fixture {
		val draws = FixtureDraws.forCase("BoardRouterWriter.read", "board_read")
		val board = BoardManager(fixtureBoard())
		var captured: OwnerOp? = null
		val ambient = world.ambient(draws)
		val ownerOps = OwnerOps(world.bootstrap(), ambient)
		val writer = BoardRouterWriter(board, { op, opId ->
			captured = ownerOps.sign(op, opId)
			buildJsonObject { put("revision", 0L); put("entries", buildJsonArray {}) }
		}) { BoardWriteResult(outcome = "applied", revision = 0L, entries = emptyList()) }
		runBlocking { writer.read("board_read-op") { result -> wireJson.decodeFromJsonElement<BoardReadResult>(result) } }
		return ownerCase(root, "BoardRouterWriter.read", "board_read", captured!!, "board_read-op", "{\"revision\":1,\"entries\":[{\"clear\":{\"id\":\"fixture-entry\",\"state\":\"open\",\"rank\":\"m\",\"version\":1}}]}", draws = draws)
	}

	private fun vaultPut(root: JsonObject): Fixture {
		val draws = FixtureDraws.forCase("VaultRouterWriter.put", "vault_put")
		val boot = world.bootstrap()
		val ambient = world.ambient(draws)
		val ownerOps = OwnerOps(boot, ambient)
		var captured: OwnerOp? = null
		val writer = VaultRouterWriter { op, opId ->
			captured = ownerOps.sign(op, opId)
			buildJsonObject { put("outcome", "applied"); put("revision", 1L) }
		}
		val sealing = VaultSealing(boot, ambient) {}
		val id = "fixture-vault"
		val put = VaultPut(
			id = id,
			expectedRevision = 0L,
			sealed = VaultEntrySealed(
				publicTitle = sealing.seal("Deploy key", VAULT_PUBLIC_TITLE_KIND, id),
				value = sealing.seal("hunter2", VAULT_VALUE_KIND, id),
			),
		)
		runBlocking { writer.put(put, "vault_put-op") }
		val op = checkNotNull(captured)
		return ownerCase(
			root,
			"VaultRouterWriter.put",
			"vault_put",
			op,
			"vault_put-op",
			"{\"outcome\":\"applied\",\"revision\":1}",
			buildJsonObject {
				put("op", op.op)
				put("opId", "vault_put-op")
				put("nonce", op.nonce)
				put("publicTitle", "Deploy key")
				put("value", "hunter2")
			},
			draws = draws,
			sealed = listOf(
				WireSealed(path = "put.sealed.publicTitle", aadKind = "vault.publicTitle\n$id", plaintextOf = "publicTitle"),
				WireSealed(path = "put.sealed.value", aadKind = "vault.value\n$id", plaintextOf = "value"),
			),
		)
	}

	private fun vaultList(root: JsonObject): Fixture {
		val draws = FixtureDraws.forCase("VaultRouterWriter.list", "vault_list")
		val ownerOps = OwnerOps(world.bootstrap(), world.ambient(draws))
		var captured: OwnerOp? = null
		val writer = VaultRouterWriter { op, opId ->
			captured = ownerOps.sign(op, opId)
			buildJsonObject { put("revision", 0L); put("since", 0L); put("entries", buildJsonArray {}) }
		}
		runBlocking { writer.list(null, "vault_list-op") }
		return ownerCase(root, "VaultRouterWriter.list", "vault_list", captured!!, "vault_list-op", "{\"revision\":1,\"since\":0}", draws = draws)
	}

	private fun keyGrant(root: JsonObject): Fixture {
		val draws = FixtureDraws.forCase("KeyDeliveryOps.onKeyGrant", "key_receipt")
		val boot = world.bootstrap()
		val ambient = world.ambient(draws)
		val envelope = Crypto.wrapContentKey(world.contentKey, 1, world.consoleIdentity.box.pub, world.ownerIdentity.sign.pub, world.ownerIdentity.sign.priv, draws::next)
		var captured: OwnerOp? = null
		val ownerOps = OwnerOps(boot, ambient)
		val ops = KeyDeliveryOps(
			boot,
			ambient,
			KeyDeliveryCollaborators(
				signOwnerOp = { op -> ownerOps.sign(op).also { captured = it } },
				sendOwnerOp = { buildJsonObject {} },
				install = { _, _ -> KeyDeliveryInstall(true, true) },
				reportError = {},
			),
		)
		runBlocking { ops.onKeyGrant(KeyGrant(1, world.consoleIdentity.sign.pub, envelope, world.clock)) }
		return ownerCase(root, "KeyDeliveryOps.onKeyGrant", "key_receipt", captured!!, "key_receipt-op", "{\"outcome\":\"accepted\"}", draws = draws)
	}

	private fun cursorTranslate(root: JsonObject): Fixture {
		val draws = FixtureDraws.forCase("CursorTranslationOps.onWelcome", "cursor_translate")
		val coordinator = ConsoleTransportCoordinator(
			IdlePushbackManager(object : IdleSilenceStore {
				override fun loadIdleSilenceStart(): Long? = null
				override fun saveIdleSilenceStart(v: Long) = Unit
			}, world.clock) { ZoneId.of("UTC") },
		).also {
			it.setMigrationEpoch(9L)
			val generation = it.beginSocket()
			it.onWelcome(generation, 3L, 4L, 0L)
		}
		val journal = MutationJournal(Files.createTempDirectory("wire-cursor").toFile())
		val ambient = world.ambient(draws)
		var captured: OwnerOp? = null
		val ownerOps = OwnerOps(world.bootstrap(), ambient)
		val ops = CursorTranslationOps(
			coordinator,
			journal,
			{ "owner:domain/owner" },
			{ 4L to 3L },
			{ op, _ -> captured = ownerOps.sign(op, "cursor_translate-op"); captured },
			{ buildJsonObject { put("translation", buildJsonObject { put("kind", "translated"); put("cursor", buildJsonObject { put("epoch", 9L); put("seq", 7L) }) }) } },
			reportError = {},
			commit = { _, _, _ -> true },
			ambient = ambient,
		)
		runBlocking { ops.onWelcome(1L, 9L, welcomeCursor = 11L, welcomeEpoch = 4L) }
		return ownerCase(root, "CursorTranslationOps.onWelcome", "cursor_translate", captured!!, "cursor_translate-op", "{\"translation\":{\"kind\":\"unmapped\"}}", draws = draws)
	}

	private fun deliver(root: JsonObject): Fixture {
		val case = "deliver"
		val draws = FixtureDraws.forCase("ConsoleClient.send", case)
		val opId = "$case-op"
		var captured: OwnerOp? = null
		val client = world.client(draws, sender = { buildJsonObject { put("ok", true) } }, onSign = { captured = it })
		val rec = ScheduledSend("fixture delivery", emptyList(), world.clock, opId, null, world.clock)
		val plan = composeScheduledSend(rec, world.clock)
		runBlocking { client.send("fixture-domain.laptop.fixture-app.abc123", plan.text, emptyList(), plan.opId, plan.targetDomainId) }
		return ownerCase(
			root,
			"ConsoleClient.send",
			case,
			captured!!,
			opId,
			"{\"outcome\":\"accepted\"}",
			buildJsonObject {
				put("op", captured!!.op)
				put("opId", opId)
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
			draws = draws,
			sealed = listOf(WireSealed(path = "row.body", aadKind = "op.payload", expectJson = buildJsonObject { put("to", "fixture-domain.laptop.fixture-app.abc123"); put("body", rec.text) })),
		)
	}

	private fun gatewayValue(root: JsonObject): Fixture {
		val case = "gateway_value"
		val draws = FixtureDraws.forCase("ConsoleClient.sendValueOp", case)
		val opId = "gateway_value-op"
		var captured: OwnerOp? = null
		val target = "fixture-domain.laptop.fixture-app.abc123"
		val client = world.client(draws, sender = { buildJsonObject { put("outcome", "accepted") } }, onSign = { captured = it })
		runBlocking { client.sendValueOp("laptop", ConsoleOp.Peek(target = target), opId) }
		return ownerCase(
			root,
			"ConsoleClient.sendValueOp",
			case,
			captured!!,
			opId,
			"{\"outcome\":\"accepted\"}",
			buildJsonObject {
				put("op", captured!!.op)
				put("opId", opId)
				put("gatewayId", "laptop")
				put("target", target)
			},
			draws = draws,
			sealed = listOf(WireSealed(path = "value", aadKind = "op.payload", expectJson = buildJsonObject { put("target", target) })),
		)
	}

	private fun keyGrantCase(root: JsonObject): Fixture {
		val case = "key_grant"
		val draws = FixtureDraws.forCase("KeyDeliveryOps.onKeyRequest", case)
		val boot = world.bootstrap()
		val ambient = world.ambient(draws)
		val gateway = world.gatewayIdentity
		val ownerOps = OwnerOps(boot, ambient)
		var captured: OwnerOp? = null
		val requestNonce = "fixture-gateway-request"
		val epochs = listOf(1L)
		val request = KeyRequest(
			1,
			world.domainId,
			gateway.sign.pub,
			epochs,
			world.clock,
			requestNonce,
			Crypto.sign(Crypto.keyRequestSigningBytes(world.domainId, gateway.sign.pub, epochs, world.clock, requestNonce), gateway.sign.priv),
		)
		val ops = KeyDeliveryOps(
			boot,
			ambient,
			KeyDeliveryCollaborators(
				signOwnerOp = { op -> ownerOps.sign(op, "key_grant-op").also { captured = it } },
				sendOwnerOp = { buildJsonObject { put("outcome", "accepted") } },
				install = { _, _ -> KeyDeliveryInstall(true, true) },
				reportError = {},
			),
		)
		runBlocking { ops.onKeyRequest(request) }
		return ownerCase(
			root,
			"KeyDeliveryOps.onKeyRequest",
			case,
			captured!!,
			"key_grant-op",
			"{\"outcome\":\"accepted\"}",
			buildJsonObject {
				put("op", captured!!.op)
				put("opId", "key_grant-op")
				put("nonce", captured!!.nonce)
				put("request", wireJson.encodeToJsonElement(KeyRequest.serializer(), request))
				put("entropy", buildJsonArray { add(draws.recordedB64(0)); add(draws.recordedB64(1)) })
			},
			draws = draws,
			sealed = listOf(WireSealed(path = "grant.envelope", aadKind = "key")),
		)
	}

	private fun reportRead(root: JsonObject): Fixture {
		val case = "report_read"
		val draws = FixtureDraws.forCase("composeReportRead", case)
		val op = OwnerOps(world.bootstrap(), world.ambient(draws)).sign(composeReportRead("fixture-domain.laptop.fixture-app.abc123", ReadAnchor(1, 1, world.clock), world.clock), "$case-op")
		return ownerCase(root, "composeReportRead", case, op, "$case-op", "{\"outcome\":\"accepted\",\"advanced\":true}", draws = draws)
	}

	private fun capabilities(root: JsonObject): Fixture {
		val case = "capabilities"
		val draws = FixtureDraws.forCase("composeCapabilitiesReport", case)
		val op = OwnerOps(world.bootstrap(), world.ambient(draws)).sign(composeCapabilitiesReport(listOf(EnabledPlugin("designer"))), "$case-op")
		return ownerCase(root, "composeCapabilitiesReport", case, op, "$case-op", "{\"known\":true,\"capabilities\":[{\"id\":\"designer\"}],\"clientVersions\":[],\"outcome\":\"accepted\"}", draws = draws)
	}

	private fun consoleOps(root: JsonObject): List<Fixture> {
		fun one(case: String, expect: String, action: suspend (ConsoleClient) -> Any?): Fixture {
			val composer = consoleComposers.getValue(case)
			val draws = FixtureDraws.forCase(composer, case)
			var captured: OwnerOp? = null
			val client = world.client(draws, sender = { buildJsonObject { put("result", buildJsonObject { put("planes", buildJsonArray {}) }) } }, onSign = { captured = it })
			runBlocking { action(client) }
			return ownerCase(root, composer, case, captured!!, "$case-op", expect, draws = draws)
		}
		return listOf(
			one("consumer_register", "{\"cursor\":0}") { it.consumerRegister(1L, "consumer_register-op") },
			one("inbox_read", "{\"outcome\":\"cursor_stale\"}") { it.inboxRead(1L, 0L, opId = "inbox_read-op") },
			one("inbox_advance", "{\"outcome\":\"cursor_stale\"}") { it.inboxAdvance(0L, 0L, "inbox_advance-op") },
			one("planes_read", "{\"outcome\":\"accepted\"}") { it.planesRead(buildJsonObject {}, "planes_read-op") },
		)
	}
	private val consoleComposers = mapOf(
		"consumer_register" to "ConsoleClient.consumerRegister",
		"inbox_read" to "ConsoleClient.inboxRead",
		"inbox_advance" to "ConsoleClient.inboxAdvance",
		"planes_read" to "ConsoleClient.planesRead",
	)

	private fun ownerCase(
		root: JsonObject,
		composer: String,
		case: String,
		ownerOp: OwnerOp,
		opId: String,
		expect: String,
		inputs: JsonObject? = null,
		draws: FixtureDraws,
		sealed: List<WireSealed>? = null,
	): Fixture {
		val request = buildOwnerOpRequest("https://router.test", ownerOp, world.consoleToken)
		val buffer = Buffer()
		request.body!!.writeTo(buffer)
		val body = buffer.readUtf8()
		val headers = buildJsonObject { request.headers.names().forEach { put(it.lowercase(), request.header(it)!!) } }
		val fixture = WireFixture.Kotlin(
			composer = composer,
			case = case,
			clock = world.clock,
			inputs = draws.inputs(inputs ?: buildJsonObject { put("op", ownerOp.op); put("opId", opId); put("nonce", ownerOp.nonce) }),
			expect = wireJson.parseToJsonElement(expect).jsonObject,
			request = WireRequest(request.method, request.url.encodedPath, headers, body), sealed = sealed,
		)
		val manifest = WireFixtureEntry("$composer/$case.json", composer, case, "router.handle")
		return Triple("$composer/$case.json", manifest, fixture)
	}

	private fun fixtureBoard(): BoardStore = object : BoardStore {
		override fun loadTaskBoard(): String? = null
		override fun saveTaskBoard(json: String) = Unit
		override fun loadGatewayId(): String = "fixture-gateway"
	}

	private fun transportCase(
		name: String,
		composer: String,
		request: Request,
		peer: String = "router.handle",
		expect: String = "{}",
	): Fixture {
		val draws = FixtureDraws.forCase(composer, name)
		val buffer = Buffer()
		request.body?.writeTo(buffer)
		val headers = buildJsonObject { request.headers.names().forEach { put(it.lowercase(), request.header(it)!!) } }
		val fixture = WireFixture.Kotlin(
			composer = composer,
			case = name,
			clock = world.clock,
			inputs = draws.inputs(),
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

	private fun render(value: WireFixture): String = Json(from = wireJson) { prettyPrint = true; prettyPrintIndent = "\t" }
		.encodeToString(WireFixture.serializer(), value) + "\n"
	private fun render(value: WireManifest): String = Json(from = wireJson) { prettyPrint = true; prettyPrintIndent = "\t" }
		.encodeToString(WireManifest.serializer(), value) + "\n"
	private fun read(file: File): String = file.takeIf(File::exists)?.readText() ?: ""
}
