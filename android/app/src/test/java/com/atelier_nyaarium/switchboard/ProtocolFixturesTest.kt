package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleCloseSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleCreateSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleForgetResult
import com.atelier_nyaarium.switchboard.proto.ConsoleListDirsResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.ConsoleSendResult
import com.atelier_nyaarium.switchboard.proto.InboxRow
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.PlanesReadResult
import com.atelier_nyaarium.switchboard.proto.PlanesReadValue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolFixturesTest {
	private fun fixture(name: String): String =
		javaClass.classLoader?.getResourceAsStream("protocol/$name")?.bufferedReader()?.use { it.readText() }
			?: error("missing protocol fixture: $name")

	private fun decodeAs(schema: String, body: String): Any =
		when (schema) {
			"ConsoleOp" -> wireJson.decodeFromString<ConsoleOp>(body)
			"OwnerOp" -> wireJson.decodeFromString<OwnerOp>(body)
			"InboxRow" -> wireJson.decodeFromString<InboxRow>(body)
			"PlanesReadValue" -> wireJson.decodeFromString<PlanesReadValue>(body)
			"PlanesReadResult" -> wireJson.decodeFromString<PlanesReadResult>(body)
			"ConsoleSendResult" -> wireJson.decodeFromString<ConsoleSendResult>(body)
			"ConsoleCreateSessionResult" -> wireJson.decodeFromString<ConsoleCreateSessionResult>(body)
			"ConsoleCloseSessionResult" -> wireJson.decodeFromString<ConsoleCloseSessionResult>(body)
			"ConsoleForgetResult" -> wireJson.decodeFromString<ConsoleForgetResult>(body)
			"ConsoleListDirsResult" -> wireJson.decodeFromString<ConsoleListDirsResult>(body)
			"ConsolePeekResult" -> wireJson.decodeFromString<ConsolePeekResult>(body)
			else -> error("unknown manifest schema: $schema")
		}

	@Test
	fun everyManifestFixtureExistsAndDecodesAsDeclared() {
		val manifest = wireJson.parseToJsonElement(fixture("_manifest.json")).jsonObject["fixtures"]!!.jsonArray
		assertTrue("manifest must not be empty", manifest.isNotEmpty())
		for (entry in manifest) {
			val obj = entry.jsonObject
			val file = obj["file"]!!.jsonPrimitive.content
			val schema = obj["schema"]!!.jsonPrimitive.content
			val expectPass = obj["expect"]!!.jsonPrimitive.content == "pass"
			val decoded = runCatching { decodeAs(schema, fixture(file)) }
			assertEquals("$file decode result", expectPass, decoded.isSuccess)
			if (expectPass) assertNotNull("$file decoded as $schema", decoded.getOrNull())
		}
	}

	@Test
	fun preservesLargeIntegers() {
		val owner = wireJson.decodeFromString<OwnerOp>(fixture("owner-op.json"))
		assertTrue(owner.at > Int.MAX_VALUE.toLong())
		val planes = wireJson.decodeFromString<PlanesReadValue>(fixture("planes-read-value.json"))
		assertEquals(4294967296L, planes.known["presence"]!!.jsonPrimitive.long)
	}

	@Test
	fun toleratesAdditiveUnknownFields() {
		val original = wireJson.parseToJsonElement(fixture("console-op-send.json")).jsonObject
		val withUnknown = JsonObject(original + ("futureField" to JsonPrimitive(true)))
		val decoded = wireJson.decodeFromJsonElement<ConsoleOp>(withUnknown)
		assertTrue(decoded is ConsoleOp.Send)
		assertEquals("status?", (decoded as ConsoleOp.Send).body)
	}

	@Test
	fun retainsResultShapes() {
		assertEquals("delivered", wireJson.decodeFromString<ConsoleSendResult>(fixture("send-result.json")).status)
		assertEquals(
			"pending",
			wireJson.decodeFromString<ConsoleCreateSessionResult>(fixture("create-session-result-pending.json")).status,
		)
		assertTrue(wireJson.decodeFromString<ConsoleCloseSessionResult>(fixture("close-session-result.json")).closed)
		assertEquals(
			"release",
			wireJson.decodeFromString<ConsoleForgetResult>(fixture("forget-result-release.json")).boardDisposition,
		)
		assertNotNull(wireJson.decodeFromString<ConsoleListDirsResult>(fixture("list-dirs-result.json")).entries)
		assertNotNull(wireJson.decodeFromString<ConsolePeekResult>(fixture("peek-result-legacy.json")).ansi)
		assertEquals(1L, wireJson.decodeFromString<InboxRow>(fixture("inbox-row.json")).seq)
	}
}
