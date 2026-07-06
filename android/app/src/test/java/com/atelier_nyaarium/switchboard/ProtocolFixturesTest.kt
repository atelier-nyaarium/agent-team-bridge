package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleCloseSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleCreateSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleListTeamsResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleOpEnvelope
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
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
			"ConsoleCreateSessionResult" -> json.decodeFromString<ConsoleCreateSessionResult>(body)
			"ConsoleCloseSessionResult" -> json.decodeFromString<ConsoleCloseSessionResult>(body)
			"ConsolePeekResult" -> json.decodeFromString<ConsolePeekResult>(body)
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
			"op-envelope-create-session-v2.json" to ConsoleOp.CreateSession::class,
			"op-envelope-rename-session.json" to ConsoleOp.RenameSession::class,
			"op-envelope-close-session.json" to ConsoleOp.CloseSession::class,
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
	fun looseTeamCarriesRequiredGatewayIdAndKindOmitsDomainId() {
		val result = json.decodeFromString<ConsoleListTeamsResult>(fixture("list-teams-result.json"))
		assertEquals(2, result.teams.size)
		assertEquals("devcontainer", result.teams[0].kind)
		assertEquals("alice", result.teams[0].domainId)
		assertEquals("laptop", result.teams[1].gatewayId)
		assertEquals("loose", result.teams[1].kind)
		// domainId is absent for a session whose gateway has not resolved a Domain (arming);
		// consumers fall back to the local Domain.
		assertNull(result.teams[1].domainId)
	}

	@Test
	fun v2FixturesCarryVerifyingStatusAndLabels() {
		val teams = json.decodeFromString<ConsoleListTeamsResult>(fixture("list-teams-result-v2.json")).teams
		assertEquals("verifying", teams[0].status)
		assertEquals("recipe-app", teams[0].sessionLabel)
		assertEquals("online", teams[1].status)
		assertEquals("My Work", teams[1].sessionLabel)

		val create = json.decodeFromString<ConsoleOpEnvelope>(fixture("op-envelope-create-session-v2.json")).op
		assertTrue("expected CreateSession op", create is ConsoleOp.CreateSession)
		assertEquals("My Work", (create as ConsoleOp.CreateSession).displayLabel)

		val rename = json.decodeFromString<ConsoleOpEnvelope>(fixture("op-envelope-rename-session.json")).op
		assertTrue("expected RenameSession op", rename is ConsoleOp.RenameSession)
		assertEquals("Renamed Work", (rename as ConsoleOp.RenameSession).sessionLabel)
	}

	@Test
	fun createSessionResultCarriesPendingStatus() {
		val result = json.decodeFromString<ConsoleCreateSessionResult>(fixture("create-session-result-pending.json"))
		assertEquals(true, result.created)
		assertEquals("a1b2c3", result.id)
		assertEquals("My Work", result.sessionLabel)
		assertEquals("pending", result.status)
	}

	@Test
	fun closeSessionResultDecodes() {
		val result = json.decodeFromString<ConsoleCloseSessionResult>(fixture("close-session-result.json"))
		assertEquals(true, result.closed)
	}

	@Test
	fun peekResultCarriesContainerLogsAsTextAndKind() {
		val result = json.decodeFromString<ConsolePeekResult>(fixture("peek-result-container-logs.json"))
		assertEquals("container-logs", result.kind)
		assertTrue(result.text!!.contains("postCreate"))
		assertNull(result.ansi)
	}

	@Test
	fun legacyBarePeekReplyStillDecodes() {
		// An old gateway's reply carries neither kind nor text; the new class must decode it with no
		// MissingFieldException (the optional-field wire-compat guarantee).
		val result = json.decodeFromString<ConsolePeekResult>(fixture("peek-result-legacy.json"))
		assertNull(result.kind)
		assertNull(result.text)
		assertTrue(result.ansi!!.isNotEmpty())
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
