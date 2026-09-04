package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.opPayloadAadKind
import com.atelier_nyaarium.switchboard.crypto.opResultAadKind
import com.atelier_nyaarium.switchboard.crypto.valueResultAadKind
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.InboxRow
import com.atelier_nyaarium.switchboard.proto.OpKey
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.PlanesReadResult
import com.atelier_nyaarium.switchboard.proto.PlaneRead
import com.atelier_nyaarium.switchboard.proto.RowEnvelope
import com.atelier_nyaarium.switchboard.proto.RowOrigin
import java.util.Base64
import java.time.ZoneId
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.assertTrue
import org.junit.Test

class ConsoleClientOwnerOpsTest {
	private val identity = Crypto.generateIdentity()
	private val owner = Crypto.generateIdentity()
	private val ring = ContentKeyring().also { it.deriveOwned(owner, "domain", 1) }
	private val coordinator = newCoordinator()
	private val sent = mutableListOf<OwnerOp>()
	private var valueResultMode = ValueResultMode.Normal
	private val client = newClient(coordinator)

	@Test
	fun sendEmitsDeliverWithConsoleOpRowToTheSessionAddress() = runBlocking {
		val result = client.send("domain.gateway.spawn.session", "hello", opId = "send-op")
		val ownerOp = sent.single()
		val row = rowOf(ownerOp)
		val op = openConsoleOp(ownerOp)

		assertEquals("deliver", ownerOp.op["kind"]?.jsonPrimitive?.content)
		assertEquals("session:domain/gateway/spawn.session", ownerOp.op["address"]?.jsonPrimitive?.content)
		assertEquals("console_op", row.envelope.kind)
		assertEquals("console", row.envelope.origin.kind)
		assertEquals("conversation", row.envelope.opKey.conversationId)
		assertEquals("send-op", row.envelope.opKey.opId)
		assertEquals("send", kindOf(op))
		assertEquals("hello", (op as ConsoleOp.Send).body)
		assertEquals("sent", result.status)
		assertTrue(result.ok)
	}

	@Test
	fun respondEmitsDeliverAndDecodesTheOpResult() = runBlocking {
		val result = client.respond("domain.gateway.spawn.session", response = "ok", opId = "respond-op")
		val ownerOp = sent.single()
		val row = rowOf(ownerOp)
		val op = openConsoleOp(ownerOp)

		assertEquals("deliver", ownerOp.op["kind"]?.jsonPrimitive?.content)
		assertEquals("session:domain/gateway/spawn.session", ownerOp.op["address"]?.jsonPrimitive?.content)
		assertEquals("console_op", row.envelope.kind)
		assertEquals("console", row.envelope.origin.kind)
		assertEquals("conversation", row.envelope.opKey.conversationId)
		assertEquals("respond-op", row.envelope.opKey.opId)
		assertEquals("respond", kindOf(op))
		assertEquals("domain.gateway.spawn.session", (op as ConsoleOp.Respond).session_id)
		assertEquals("ok", op.response)
		assertTrue(result.delivered)
	}

	@Test
	fun tmuxRenameCloseForgetWakeAllRideDeliver() = runBlocking {
		client.tmuxSend("domain.gateway.spawn.session", text = "x", opId = "tmux-op")
		client.renameSession("domain.gateway.spawn.session", "new", opId = "rename-op")
		client.closeSession("domain.gateway.spawn.session", opId = "close-op")
		client.forget("domain.gateway.spawn.session", boardDisposition = "keep", opId = "forget-op")
		client.wake("domain.gateway.spawn.session", opId = "wake-op")
		val ownerOps = sent.toList()
		val opened = ownerOps.map { openConsoleOp(it) }

		assertEquals(listOf("deliver", "deliver", "deliver", "deliver", "deliver"), ownerOps.map { it.op["kind"]?.jsonPrimitive?.content })
		assertEquals(listOf("tmux_send", "rename_session", "close_session", "forget", "wake"), opened.map(::kindOf))
		assertEquals("x", (opened[0] as ConsoleOp.TmuxSend).text)
		assertEquals("new", (opened[1] as ConsoleOp.RenameSession).sessionLabel)
		assertEquals("domain.gateway.spawn.session", (opened[2] as ConsoleOp.CloseSession).target)
		assertEquals("keep", (opened[3] as ConsoleOp.Forget).boardDisposition)
		assertEquals("domain.gateway.spawn.session", (opened[4] as ConsoleOp.Wake).target)
		assertEquals("session:domain/gateway/spawn.session", ownerOps[0].op["address"]?.jsonPrimitive?.content)
		assertEquals("session:domain/gateway/spawn.session", ownerOps[4].op["address"]?.jsonPrimitive?.content)
	}

	// A session op addressed at a spawn-point has no inbox address to ride; refuse before posting.
	@Test
	fun aSessionOpOnASpawnPointIsRefusedBeforePosting() = runBlocking {
		val failure = runCatching { client.wake("domain.gateway.spawn", opId = "wake-op") }.exceptionOrNull()

		assertNotNull(failure)
		assertTrue(failure!!.message!!.contains("spawn-point"))
		assertTrue(sent.isEmpty())
	}

	// A read with no side effect costs no durable row.
	@Test
	fun peekRidesTheValuePath() = runBlocking {
		// The fake transport answers nothing to decode; the path taken is the assertion.
		runCatching { client.peek("domain.gateway.spawn.session") }

		assertEquals("gateway_value", sent.single().op["kind"]?.jsonPrimitive?.content)
		assertEquals("gateway", sent.single().op["gatewayId"]?.jsonPrimitive?.content)
	}

	@Test
	fun aDeliveryTimeoutAnswersTheRelayFailureShape() = runBlocking {
		val timeoutClient = newClient(null) { op -> sent += op; null }
		val result = timeoutClient.send("domain.gateway.spawn.session", "hello", opId = "timeout-op")

		assertFalse(result.ok)
		assertEquals("", result.status)
		assertEquals("transport", result.error)
		assertEquals("deliver", sent.last().op["kind"]?.jsonPrimitive?.content)
	}

	@Test
	fun anAcceptedDeliveryWithoutResultTimesOut() = runBlocking {
		val timeoutClient = newClient(newCoordinator()) { op ->
			sent += op
			buildJsonObject {
				put("opKey", buildJsonObject { put("conversationId", op.conversationId); put("opId", op.opId) })
				put("outcome", "accepted")
			}
		}
		assertNull(timeoutClient.sendDeliveryOp("session:domain/gateway/spawn.session", ConsoleOp.Wake("domain.gateway.spawn.session"), "accepted-timeout", 5L))
	}

	@Test
	fun createSessionAndListDirsEmitGatewayValueToTheTargetGateway() = runBlocking {
		val created = client.createSession("domain.gateway.spawn.session", displayLabel = "Demo", opId = "create-op")
		val dirs = client.listDirs("/tmp", "domain.gateway.spawn.session", "spawn")
		val createOp = openConsoleOp(valueOwnerOp("create-op"))
		val dirsOp = openConsoleOp(sent[1])

		assertEquals("gateway_value", sent[0].op["kind"]?.jsonPrimitive?.content)
		assertEquals("gateway", sent[0].op["gatewayId"]?.jsonPrimitive?.content)
		assertEquals("create_session", kindOf(createOp))
		assertEquals("domain.gateway.spawn.session", (createOp as ConsoleOp.CreateSession).target)
		assertEquals("Demo", createOp.displayLabel)
		assertEquals("gateway_value", sent[1].op["kind"]?.jsonPrimitive?.content)
		assertEquals("gateway", sent[1].op["gatewayId"]?.jsonPrimitive?.content)
		assertEquals("list_dirs", kindOf(dirsOp))
		assertEquals("/tmp", (dirsOp as ConsoleOp.ListDirs).path)
		assertEquals("spawn", dirsOp.spawn)
		assertEquals(listOf("one", "two"), dirs.entries)
		assertEquals("created-session", created.id)
		assertTrue(created.created)
	}

	@Test
	fun blobStatPutGetRideGatewayValue() = runBlocking {
		val stat = client.blobStat("blob")
		val put = client.blobPut("blob", 4, byteArrayOf(1, 2), true)
		val get = client.blobGet("blob", 4, 2)
		val requestOps = sent.map { openConsoleOp(it) }

		assertEquals(listOf("gateway_value", "gateway_value", "gateway_value"), sent.map { it.op["kind"]?.jsonPrimitive?.content })
		assertEquals(listOf("gateway", "gateway", "gateway"), sent.map { it.op["gatewayId"]?.jsonPrimitive?.content })
		assertEquals(listOf("blob_stat", "blob_put", "blob_get"), requestOps.map(::kindOf))
		assertEquals("blob", (requestOps[0] as ConsoleOp.BlobStat).blobId)
		assertEquals(4L, (requestOps[1] as ConsoleOp.BlobPut).offset)
		assertEquals("blob", (requestOps[1] as ConsoleOp.BlobPut).blobId)
		assertEquals(2, Base64.getDecoder().decode((requestOps[1] as ConsoleOp.BlobPut).chunk).size)
		assertEquals(4L, (requestOps[2] as ConsoleOp.BlobGet).offset)
		assertEquals(2L, (requestOps[2] as ConsoleOp.BlobGet).length)
		assertEquals(4L, stat.have)
		assertTrue(put.complete)
		assertEquals("AQI=", get.chunk)
	}

	@Test
	fun reloadPluginsAndACrossDomainOpRideGatewayValue() = runBlocking {
		val reload = client.reloadPlugins("gateway", opId = "reload-op")
		val crossDomain = client.crossDomainListen()
		val reloadOp = openConsoleOp(sent[0])
		val crossDomainOp = openConsoleOp(sent[1])

		assertEquals("gateway_value", sent[0].op["kind"]?.jsonPrimitive?.content)
		assertEquals("gateway", sent[0].op["gatewayId"]?.jsonPrimitive?.content)
		assertEquals("reload_plugins", kindOf(reloadOp))
		assertEquals("gateway", (reloadOp as ConsoleOp.ReloadPlugins).target)
		assertEquals("gateway_value", sent[1].op["kind"]?.jsonPrimitive?.content)
		assertEquals("gateway", sent[1].op["gatewayId"]?.jsonPrimitive?.content)
		assertEquals("cross_domain_listen", kindOf(crossDomainOp))
		assertTrue(reload.initiated)
		assertEquals("listen-token", crossDomain.listeningToken)
	}

	@Test
	fun aValueResultOpensUnderTheValueResultAad() = runBlocking {
		val answer = client.sendValueOp("gateway", ConsoleOp.ListDirs("/", "spawn"), "value-op")

		assertNotNull(answer)
		assertEquals(
			listOf("one", "two"),
			answer?.jsonObject?.get("result")?.jsonObject?.get("entries")?.jsonArray?.map { it.jsonPrimitive.content },
		)
		val request = openConsoleOp(sent.single()) as ConsoleOp.ListDirs
		assertEquals("/", request.path)
		assertEquals("spawn", request.spawn)
		assertEquals("gateway_value", sent.single().op["kind"]?.jsonPrimitive?.content)
	}

	@Test
	fun aValueResultSealedForAnotherOpIdFailsToOpen() = runBlocking {
		valueResultMode = ValueResultMode.WrongOp
		val answer = client.sendValueOp("gateway", ConsoleOp.ListDirs("/", "spawn"), "value-op")

		assertEquals(null, answer)
		assertEquals("gateway_value", sent.single().op["kind"]?.jsonPrimitive?.content)
	}

	@Test
	fun aRefusedValueOpAnswersItsReasonInTheClear() = runBlocking {
		valueResultMode = ValueResultMode.Refused
		val answer = client.sendValueOp("gateway", ConsoleOp.ListDirs("/", "spawn"), "value-op")

		val decoded = wireJson.decodeFromJsonElement(OwnerOpAnswer.serializer(), requireNotNull(answer))
		assertEquals(false, decoded.ok)
		assertEquals("session is not ready", decoded.error)
	}

	@Test
	fun backgroundTickReadsInboxThenPlanesWithAppliedVersions() = runBlocking {
		val events = mutableListOf<String>()
		val outcome = drainTick(client, coordinator, emptyMap(), { events += "rows" }, { name, version, _ -> events += "$name:$version"; true })

		assertEquals(listOf("inbox_read", "inbox_advance", "planes_read"), sent.map { it.op["kind"]?.jsonPrimitive?.content })
		assertEquals(listOf("rows", "board:3"), events)
		assertEquals(3L, outcome.known["board"])
		assertTrue(outcome.inboxAdvanceSent)
	}

	@Test
	fun aFailedInboxAdvanceIsRetriedBeforeTheNextRead() = runBlocking {
		val retryCoordinator = newCoordinator()
		var advances = 0
		val retryClient = newClient(retryCoordinator) { op ->
			if (op.op["kind"]?.jsonPrimitive?.content == "inbox_advance" && advances++ == 0) {
				sent += op
				null
			} else {
				answer(op, retryCoordinator)
			}
		}

		drainTick(retryClient, retryCoordinator, emptyMap(), {}, { _, _, _ -> true })
		assertEquals(PendingInboxAdvance(2L, 0L), retryCoordinator.pendingAdvance())
		drainTick(retryClient, retryCoordinator, emptyMap(), {}, { _, _, _ -> true })

		assertEquals(
			listOf("inbox_read", "inbox_advance", "planes_read", "inbox_advance", "inbox_read", "planes_read"),
			sent.map { it.op["kind"]?.jsonPrimitive?.content },
		)
		assertEquals(null, retryCoordinator.pendingAdvance())
	}

	@Test
	fun aCursorStaleFloorIsReadOnTheNextTick() = runBlocking {
		val floorCoordinator = newCoordinator()
		var reads = 0
		val floorClient = newClient(floorCoordinator) { op ->
			if (op.op["kind"]?.jsonPrimitive?.content == "inbox_read" && reads++ == 0) {
				sent += op
				buildJsonObject { put("outcome", "cursor_stale"); put("floor", 5) }
			} else {
				answer(op, floorCoordinator)
			}
		}

		val first = drainTick(floorClient, floorCoordinator, emptyMap(), {}, { _, _, _ -> true })
		drainTick(floorClient, floorCoordinator, first.known, {}, { _, _, _ -> true })

		assertEquals(
			listOf(1L, 5L),
			sent.filter { it.op["kind"]?.jsonPrimitive?.content == "inbox_read" }
				.map { it.op["fromSeq"]?.jsonPrimitive?.content?.toLong() },
		)
	}

	@Test
	fun anAnsweredPlaneAppliesOnceThroughTheSocketReducer() = runBlocking {
		var applied = 0
		val first = drainTick(client, coordinator, emptyMap(), {}, { _, _, _ -> applied++; true })
		val second = drainTick(client, coordinator, first.known, {}, { _, _, _ -> applied++; true })

		assertEquals(1, applied)
		assertEquals(1, first.planesApplied)
		assertEquals(0, second.planesApplied)
		assertEquals(3L, second.known["board"])
		assertEquals(listOf("inbox_read", "inbox_advance", "planes_read", "inbox_read", "planes_read"), sent.map { it.op["kind"]?.jsonPrimitive?.content })
	}

	@Test
	fun reportReadEmitsTheReportReadOwnerOp() = runBlocking {
		val result = client.reportRead("team", ReadAnchor(7, 9, 0L), opId = "read-op")
		val ownerOp = sent.single()
		val report = wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.ReportRead.serializer(), ownerOp.op)

		assertEquals("report_read", ownerOp.op["kind"]?.jsonPrimitive?.content)
		assertEquals("team", report.team)
		assertEquals(7L, report.epoch)
		assertEquals(9L, report.seq)
		assertTrue(report.at > 0L)
		assertTrue(result.advanced)
	}

	private fun newClient(
		coordinator: ConsoleTransportCoordinator?,
		sender: suspend (OwnerOp) -> JsonElement? = { op -> answer(op, coordinator) },
	): ConsoleClient {
		val store = testStore().also { it.saveGatewayId("gateway") }
		val boot = testBootstrap(store, "domain", identity, owner, ring, device = "device", conversationId = "conversation")
		return ConsoleClient(
		boot,
		testAmbient(clock = 1L, nonce = "nonce", opId = "op", nonceBytes = ByteArray(12)),
		store,
		coordinator = coordinator,
		collaborators = ConsoleClientCollaborators(
			signOwnerOp = { op, opId -> OwnerOp(1, "domain", "owner", "conversation", "device", opId, 1, "nonce", op, "sig") },
			homeGatewayId = { "gateway" },
		postOwnerOpSender = sender,
		rowSigner = { "row-sig" },
		),
		)
	}

	private suspend fun answer(op: OwnerOp, coordinator: ConsoleTransportCoordinator?): JsonElement? {
		sent += op
		return when (op.op["kind"]?.jsonPrimitive?.content) {
			"deliver" -> {
				val body = when (kindOf(openConsoleOp(op))) {
					"send" -> reply(com.atelier_nyaarium.switchboard.proto.ConsoleSendResult.serializer(), com.atelier_nyaarium.switchboard.proto.ConsoleSendResult("session", "sent"))
					"respond" -> reply(com.atelier_nyaarium.switchboard.proto.ConsoleRespondResult.serializer(), com.atelier_nyaarium.switchboard.proto.ConsoleRespondResult(true))
					"peek" -> reply(com.atelier_nyaarium.switchboard.proto.ConsolePeekResult.serializer(), com.atelier_nyaarium.switchboard.proto.ConsolePeekResult(hash = "hash"))
					"rename_session" -> reply(com.atelier_nyaarium.switchboard.proto.ConsoleRenameSessionResult.serializer(), com.atelier_nyaarium.switchboard.proto.ConsoleRenameSessionResult(true, "new"))
					"forget" -> reply(com.atelier_nyaarium.switchboard.proto.ConsoleForgetResult.serializer(), com.atelier_nyaarium.switchboard.proto.ConsoleForgetResult(true, "keep"))
					else -> wireJson.encodeToJsonElement(OwnerOpAnswer.serializer(), OwnerOpAnswer(true))
				}
				val sealed = Crypto.sealContent(
					body.toString().toByteArray(),
					requireNotNull(ring.keyFor(1)),
					Crypto.ContentAad("domain", owner.sign.pub,1, opResultAadKind(op.conversationId, op.opId)),
				)
				val opened = Crypto.openContent(sealed, requireNotNull(ring.keyFor(1)), Crypto.ContentAad("domain", owner.sign.pub,1, opResultAadKind(op.conversationId, op.opId)))
				kotlinx.coroutines.yield()
				coordinator?.completeOpResult(op.opId, wireJson.parseToJsonElement(opened.toString(Charsets.UTF_8)))
				buildJsonObject {
					put("opKey", buildJsonObject { put("conversationId", op.conversationId); put("opId", op.opId) })
					put("outcome", "accepted")
				}
			}
			"gateway_value" -> valueAnswer(op)
			"inbox_read" -> buildJsonArray { add(wireJson.encodeToJsonElement(InboxRow.serializer(), tickRow())) }
			"inbox_advance" -> buildJsonObject { put("outcome", "ok") }
			"planes_read" -> buildJsonObject {
				put(
					"result",
					wireJson.encodeToJsonElement(
						PlanesReadResult.serializer(),
						PlanesReadResult(listOf(PlaneRead("board", 3, buildJsonObject { put("value", true) }))),
					),
				)
			}
			"report_read" -> wireJson.encodeToJsonElement(com.atelier_nyaarium.switchboard.proto.ConsoleReportReadResult.serializer(), com.atelier_nyaarium.switchboard.proto.ConsoleReportReadResult(true))
			else -> null
		}
	}

	private fun valueAnswer(ownerOp: OwnerOp): JsonElement {
		if (valueResultMode == ValueResultMode.Refused) {
			return buildJsonObject {
				put("opKey", buildJsonObject { put("conversationId", ownerOp.conversationId); put("opId", ownerOp.opId) })
				put("outcome", "accepted")
				put("result", buildJsonObject { put("kind", "refusal"); put("reason", "session is not ready") })
			}
		}
		val request = openConsoleOp(ownerOp)
		val result = when (kindOf(request)) {
			"create_session" -> buildJsonObject { put("created", true); put("id", "created-session") }
			"list_dirs" -> buildJsonObject { put("entries", buildJsonArray { add(JsonPrimitive("one")); add(JsonPrimitive("two")) }) }
			"blob_stat" -> buildJsonObject { put("have", 4); put("complete", true) }
			"blob_put" -> buildJsonObject { put("have", 6); put("complete", true) }
			"blob_get" -> buildJsonObject { put("chunk", "AQI="); put("eof", true) }
			"reload_plugins" -> buildJsonObject { put("initiated", true) }
			"cross_domain_listen" -> buildJsonObject {
				put("listeningToken", "listen-token"); put("receiverOwnerSignPub", "owner")
				put("receiverGatewaySignPub", "gateway"); put("receiverGatewayBoxPub", "box")
				put("receiverDomainId", "domain"); put("receiverGatewayId", "gateway"); put("expiresAt", 10)
			}
			else -> buildJsonObject { put("field", "created") }
		}
		val resultOpId = if (valueResultMode == ValueResultMode.WrongOp) "other-op" else ownerOp.opId
		val envelope = Crypto.sealContent(
			result.toString().toByteArray(),
			requireNotNull(ring.keyFor(1)),
			Crypto.ContentAad("domain", owner.sign.pub,1, valueResultAadKind(resultOpId)),
		)
		return buildJsonObject {
			put("opKey", buildJsonObject { put("conversationId", ownerOp.conversationId); put("opId", ownerOp.opId) })
			put("outcome", "accepted")
			put("result", wireJson.encodeToJsonElement(ContentEnvelope.serializer(), envelope))
		}
	}

	private fun <T> reply(serializer: kotlinx.serialization.KSerializer<T>, result: T): JsonElement =
		wireJson.encodeToJsonElement(OwnerOpAnswer.serializer(), OwnerOpAnswer(true, wireJson.encodeToJsonElement(serializer, result)))

	private fun rowOf(ownerOp: OwnerOp): InboxRow =
		wireJson.decodeFromJsonElement(InboxRow.serializer(), requireNotNull(ownerOp.op["row"]))

	private fun valueOwnerOp(opId: String): OwnerOp = sent.first { it.opId == opId }

	private fun kindOf(op: ConsoleOp): String =
		wireJson.encodeToJsonElement(ConsoleOp.serializer(), op).jsonObject.getValue("kind").jsonPrimitive.content

	private fun openConsoleOp(ownerOp: OwnerOp): ConsoleOp {
		val body = if (ownerOp.op["row"] != null) rowOf(ownerOp).body else ownerOp.op.getValue("value")
		val envelope = wireJson.decodeFromJsonElement(ContentEnvelope.serializer(), body)
		val plain = Crypto.openContent(
			envelope,
			requireNotNull(ring.keyFor(envelope.epoch.toInt())),
			Crypto.ContentAad("domain", owner.sign.pub,envelope.epoch.toInt(), opPayloadAadKind()),
		)
		return wireJson.decodeFromString(ConsoleOp.serializer(), plain.toString(Charsets.UTF_8))
	}

	private fun tickRow(): InboxRow = InboxRow(
		RowEnvelope(RowOrigin("console", "domain", device = "device"), OpKey("conversation", "tick-op"), kotlinx.serialization.json.JsonPrimitive(1), "notice", emptyList()),
		"row-sig", buildJsonObject {}, 2, 3, 4,
	)

	private fun newCoordinator(): ConsoleTransportCoordinator =
		ConsoleTransportCoordinator(
			IdlePushbackManager(object : IdleSilenceStore {
				override fun loadIdleSilenceStart(): Long? = null
				override fun saveIdleSilenceStart(v: Long) {}
			}, 0L) { ZoneId.of("UTC") },
		)

	private enum class ValueResultMode { Normal, WrongOp, Refused }
}
