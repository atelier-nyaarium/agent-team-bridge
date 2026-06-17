package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.PhoneListTeamsResult
import com.atelier_nyaarium.switchboard.proto.PhoneOp
import com.atelier_nyaarium.switchboard.proto.PhoneOpEnvelope
import com.atelier_nyaarium.switchboard.proto.PhonePollResult
import com.atelier_nyaarium.switchboard.proto.PhoneRegisterResult
import com.atelier_nyaarium.switchboard.proto.PhoneRelayFrame
import com.atelier_nyaarium.switchboard.proto.PhoneRelayReply
import com.atelier_nyaarium.switchboard.proto.PhoneReplyBody
import com.atelier_nyaarium.switchboard.proto.PhoneRespondResult
import com.atelier_nyaarium.switchboard.proto.PhoneSendResult
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
			"PhoneOpEnvelope" -> json.decodeFromString<PhoneOpEnvelope>(body)
			"PhoneRelayFrame" -> json.decodeFromString<PhoneRelayFrame>(body)
			"PhoneRelayReply" -> json.decodeFromString<PhoneRelayReply>(body)
			"PhoneReplyBody" -> json.decodeFromString<PhoneReplyBody>(body)
			"MailboxEntry" -> json.decodeFromString<MailboxEntry>(body)
			"PhoneRegisterResult" -> json.decodeFromString<PhoneRegisterResult>(body)
			"PhoneListTeamsResult" -> json.decodeFromString<PhoneListTeamsResult>(body)
			"PhoneSendResult" -> json.decodeFromString<PhoneSendResult>(body)
			"PhoneRespondResult" -> json.decodeFromString<PhoneRespondResult>(body)
			"PhonePollResult" -> json.decodeFromString<PhonePollResult>(body)
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
			"op-envelope-register.json" to PhoneOp.Register::class,
			"op-envelope-list-teams.json" to PhoneOp.ListTeams::class,
			"op-envelope-send.json" to PhoneOp.Send::class,
			"op-envelope-respond.json" to PhoneOp.Respond::class,
			"op-envelope-poll.json" to PhoneOp.Poll::class,
		)
		for ((name, expected) in ops) {
			val envelope = json.decodeFromString<PhoneOpEnvelope>(fixture(name))
			assertEquals(name, expected, envelope.op::class)
		}
	}

	@Test
	fun frameRoundTripsThroughEncode() {
		val envelope = json.decodeFromString<PhoneOpEnvelope>(fixture("op-envelope-send.json"))
		val redecoded = json.decodeFromString<PhoneOpEnvelope>(json.encodeToString(PhoneOpEnvelope.serializer(), envelope))
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
	fun toleratesOldArbiterTeamWithoutKind() {
		val result = json.decodeFromString<PhoneListTeamsResult>(fixture("list-teams-result.json"))
		assertEquals(2, result.teams.size)
		assertEquals("devcontainer", result.teams[0].kind)
		assertNull(result.teams[1].kind)
	}

	@Test
	fun decodesNestedRelayReplyResultPerOp() {
		// reply-body.json holds the sealed inner reply as PhoneReplyBody (plaintext fixture).
		val body = json.decodeFromString<PhoneReplyBody>(fixture("reply-body.json"))
		assertTrue(body.ok)
		assertNull(body.error)
		// The untyped result payload decodes per-op; here it is a poll result.
		val nested = json.decodeFromString<PhonePollResult>(body.result.toString())
		assertEquals(0, nested.entries.size)
	}
}
