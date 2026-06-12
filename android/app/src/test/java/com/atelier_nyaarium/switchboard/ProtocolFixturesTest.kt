package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.PhoneListTeamsResult
import com.atelier_nyaarium.switchboard.proto.PhoneOp
import com.atelier_nyaarium.switchboard.proto.PhonePollResult
import com.atelier_nyaarium.switchboard.proto.PhoneRegisterResult
import com.atelier_nyaarium.switchboard.proto.PhoneRelayFrame
import com.atelier_nyaarium.switchboard.proto.PhoneRelayReply
import com.atelier_nyaarium.switchboard.proto.PhoneSendResult
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decodes the golden protocol fixtures (tests/fixtures/protocol at the repo
 * root, wired as test resources) with the generated proto/ types. The same
 * files are parsed by the zod schemas in vitest, so the two runtimes cannot
 * drift on the wire shape without a red suite.
 */
class ProtocolFixturesTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun fixture(name: String): String =
		javaClass.classLoader!!.getResourceAsStream("protocol/$name")!!.bufferedReader().readText()

	@Test
	fun decodesEveryOpKindThroughTheFrame() {
		val ops = mapOf(
			"frame-register.json" to PhoneOp.Register::class,
			"frame-list-teams.json" to PhoneOp.ListTeams::class,
			"frame-send.json" to PhoneOp.Send::class,
			"frame-respond.json" to PhoneOp.Respond::class,
			"frame-poll.json" to PhoneOp.Poll::class,
		)
		for ((name, expected) in ops) {
			val frame = json.decodeFromString<PhoneRelayFrame>(fixture(name))
			assertEquals(name, expected, frame.op::class)
		}
	}

	@Test
	fun frameRoundTripsThroughEncode() {
		val frame = json.decodeFromString<PhoneRelayFrame>(fixture("frame-send.json"))
		val redecoded = json.decodeFromString<PhoneRelayFrame>(json.encodeToString(PhoneRelayFrame.serializer(), frame))
		assertEquals(frame, redecoded)
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
	fun toleratesUnknownExtraFields() {
		val entry = json.decodeFromString<MailboxEntry>(fixture("tolerance-extra-field.json"))
		assertEquals(46L, entry.seq)
	}

	@Test
	fun rejectsMissingRequiredField() {
		try {
			json.decodeFromString<MailboxEntry>(fixture("invalid-missing-required.json"))
			throw AssertionError("decode must fail on missing session_id")
		} catch (expected: SerializationException) {
			// missing non-nullable field
		}
	}

	@Test
	fun toleratesOldArbiterTeamWithoutKind() {
		val result = json.decodeFromString<PhoneListTeamsResult>(fixture("list-teams-result.json"))
		assertEquals(2, result.teams.size)
		assertEquals("devcontainer", result.teams[0].kind)
		assertNull(result.teams[1].kind)
	}

	@Test
	fun decodesRemainingOpResultsAndErrorReply() {
		val register = json.decodeFromString<PhoneRegisterResult>(fixture("register-result.json"))
		assertEquals(42L, register.cursor)

		val send = json.decodeFromString<PhoneSendResult>(fixture("send-result.json"))
		assertEquals("delivered", send.status)

		val failed = json.decodeFromString<PhoneRelayReply>(fixture("relay-reply-error.json"))
		assertEquals(false, failed.ok)
		assertTrue(failed.error!!.isNotEmpty())

		val withFiles = json.decodeFromString<MailboxEntry>(fixture("mailbox-reply-files.json"))
		assertEquals(1, withFiles.files!!.size)
		assertEquals("Which environment?", withFiles.question)
	}

	@Test
	fun decodesPollResultAndRelayReply() {
		val poll = json.decodeFromString<PhonePollResult>(fixture("poll-result.json"))
		assertEquals(1, poll.entries.size)
		assertEquals(42L, poll.cursor)

		val reply = json.decodeFromString<PhoneRelayReply>(fixture("relay-reply.json"))
		assertTrue(reply.ok)
		assertNull(reply.error)
		// The untyped result payload decodes per-op; here it is a poll result.
		val nested = json.decodeFromString<PhonePollResult>(reply.result.toString())
		assertEquals(0, nested.entries.size)
	}
}
