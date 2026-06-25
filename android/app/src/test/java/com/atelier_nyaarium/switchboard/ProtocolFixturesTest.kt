package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleListTeamsResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleOpEnvelope
import com.atelier_nyaarium.switchboard.proto.ConsolePollResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRegisterResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRelayFrame
import com.atelier_nyaarium.switchboard.proto.ConsoleRelayReply
import com.atelier_nyaarium.switchboard.proto.ConsoleReplyBody
import com.atelier_nyaarium.switchboard.proto.ConsoleRespondResult
import com.atelier_nyaarium.switchboard.proto.ConsoleSendResult
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decodes the golden protocol fixtures with the generated proto/ types. The
 * inventory is _manifest.json (also iterated by the vitest suite), so the two
 * runtimes always test the same corpus: a fixture missing from the manifest
 * fails the vitest directory check, and a manifest entry this suite cannot
 * decode fails here.
 */
class ProtocolFixturesTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun fixture(name: String): String =
		javaClass.classLoader!!.getResourceAsStream("protocol/$name")!!.bufferedReader().readText()

	private fun decodeAs(schema: String, body: String) {
		when (schema) {
			"ConsoleOpEnvelope" -> json.decodeFromString<ConsoleOpEnvelope>(body)
			"ConsoleRelayFrame" -> json.decodeFromString<ConsoleRelayFrame>(body)
			"ConsoleRelayReply" -> json.decodeFromString<ConsoleRelayReply>(body)
			"ConsoleReplyBody" -> json.decodeFromString<ConsoleReplyBody>(body)
			"MailboxEntry" -> json.decodeFromString<MailboxEntry>(body)
			"ConsoleRegisterResult" -> json.decodeFromString<ConsoleRegisterResult>(body)
			"ConsoleListTeamsResult" -> json.decodeFromString<ConsoleListTeamsResult>(body)
			"ConsoleSendResult" -> json.decodeFromString<ConsoleSendResult>(body)
			"ConsoleRespondResult" -> json.decodeFromString<ConsoleRespondResult>(body)
			"ConsolePollResult" -> json.decodeFromString<ConsolePollResult>(body)
			else -> throw AssertionError("unknown manifest schema: $schema")
		}
	}

	@Test
	fun everyManifestFixtureDecodesAsDeclared() {
		val manifest = json.parseToJsonElement(fixture("_manifest.json")).jsonObject["fixtures"]!!.jsonArray
		assertTrue("manifest must not be empty", manifest.isNotEmpty())
		for (entry in manifest) {
			val obj = entry.jsonObject
			val file = obj["file"]!!.jsonPrimitive.content
			val schema = obj["schema"]!!.jsonPrimitive.content
			val expectPass = obj["expect"]!!.jsonPrimitive.content == "pass"
			try {
				decodeAs(schema, fixture(file))
				assertTrue("$file decoded but manifest expects failure", expectPass)
			} catch (e: SerializationException) {
				assertTrue("$file failed to decode as $schema: ${e.message}", !expectPass)
			}
		}
	}

	@Test
	fun decodesEveryOpKindThroughTheFrame() {
		val ops = mapOf(
			"op-envelope-register.json" to ConsoleOp.Register::class,
			"op-envelope-list-teams.json" to ConsoleOp.ListTeams::class,
			"op-envelope-send.json" to ConsoleOp.Send::class,
			"op-envelope-respond.json" to ConsoleOp.Respond::class,
			"op-envelope-poll.json" to ConsoleOp.Poll::class,
		)
		for ((name, expected) in ops) {
			val envelope = json.decodeFromString<ConsoleOpEnvelope>(fixture(name))
			assertEquals(name, expected, envelope.op::class)
		}
	}

	@Test
	fun frameRoundTripsThroughEncode() {
		val envelope = json.decodeFromString<ConsoleOpEnvelope>(fixture("op-envelope-send.json"))
		val redecoded = json.decodeFromString<ConsoleOpEnvelope>(json.encodeToString(ConsoleOpEnvelope.serializer(), envelope))
		assertEquals(envelope, redecoded)
	}

	@Test
	fun decodesEveryMailboxKindAndLongAt() {
		val message = json.decodeFromString<MailboxEntry>(fixture("mailbox-message.json"))
		assertTrue("at must survive as a Long above 2^31", message.at > Int.MAX_VALUE.toLong())
		assertEquals("message", message.kind)

		val reply = json.decodeFromString<MailboxEntry>(fixture("mailbox-reply.json"))
		assertEquals("completed", reply.status)

		val notice = json.decodeFromString<MailboxEntry>(fixture("mailbox-notice.json"))
		assertEquals("Phase 0 done: deps mature-pinned", notice.title)
		assertTrue(notice.summary!!.isNotEmpty())
	}

	@Test
	fun toleratesOutOfUnionRequestType() {
		val entry = json.decodeFromString<MailboxEntry>(fixture("mailbox-handoff.json"))
		assertEquals("handoff", entry.request_type)
	}

	@Test
	fun toleratesOldGatewayTeamWithoutKindAndCarriesDomainId() {
		val result = json.decodeFromString<ConsoleListTeamsResult>(fixture("list-teams-result.json"))
		assertEquals(2, result.teams.size)
		assertEquals("devcontainer", result.teams[0].kind)
		assertEquals("alice", result.teams[0].domainId)
		assertNull(result.teams[1].kind)
		// A pre-federation team omits the Domain id; it decodes as null (consumers fall back
		// to the local Domain).
		assertNull(result.teams[1].domainId)
	}

	@Test
	fun decodesNestedRelayReplyResultPerOp() {
		// reply-body.json holds the sealed inner reply as ConsoleReplyBody (plaintext fixture).
		val body = json.decodeFromString<ConsoleReplyBody>(fixture("reply-body.json"))
		assertTrue(body.ok)
		assertNull(body.error)
		// The untyped result payload decodes per-op; here it is a poll result.
		val nested = json.decodeFromString<ConsolePollResult>(body.result.toString())
		assertEquals(0, nested.entries.size)
	}
}
