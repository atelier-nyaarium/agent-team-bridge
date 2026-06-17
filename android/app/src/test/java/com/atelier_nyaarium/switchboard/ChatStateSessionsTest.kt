package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.NoticeId
import com.atelier_nyaarium.switchboard.proto.SessionId
import com.atelier_nyaarium.switchboard.proto.TeamAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for Slice 3 behavior: the presence-join fix and the Face-4 mis-thread rule.
 *
 * These tests do not require Android context (no Robolectric): they exercise pure
 * data-class logic on ChatState and the SessionId/TeamAddress/NoticeId twin.
 */
class ChatStateSessionsTest {

	// -- Helper builders --

	private fun makeTeam(name: String, status: String = "online") =
		Team(name = name, status = status, mode = "channel", queueDepth = 0)

	private fun makeMsg(text: String = "hello") =
		Message(fromMe = false, text = text, at = 1000L)

	private fun stateWith(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		localSwitchId: String = "",
	) = ChatState(
		teams = teams,
		threads = threads,
		localSwitchId = localSwitchId,
	)

	// -- Presence join tests --

	@Test
	fun sessionsDoesNotSynthesizeEndedForLiveTeam_qualifiedMatch() {
		// Both team list and thread key use the same canonical qualified form.
		val localSwitchId = "switchboard"
		val canonical = "switchboard/api"
		val state = stateWith(
			teams = listOf(makeTeam(canonical, "online")),
			threads = mapOf(canonical to listOf(makeMsg())),
			localSwitchId = localSwitchId,
		)
		val sessions = state.sessions(localSwitchId)
		assertEquals(1, sessions.size)
		assertEquals("online", sessions[0].status)
		assertFalse("live session must never be synthesized as ended",
			sessions.any { it.status == "ended" })
	}

	@Test
	fun sessionsDoesNotSynthesizeEndedForLiveTeam_bareVsQualified() {
		// Bug scenario: thread key was stored bare ("api") but the team list carries
		// the qualified form ("switchboard/api"). Without the canonical join these two
		// disagree, producing a phantom "ended" entry. FAILS on the old raw-string getter.
		val localSwitchId = "switchboard"
		val state = stateWith(
			teams = listOf(makeTeam("switchboard/api", "online")),
			threads = mapOf("api" to listOf(makeMsg())),
			localSwitchId = localSwitchId,
		)
		val sessions = state.sessions(localSwitchId)
		assertEquals(1, sessions.size)
		assertEquals("online", sessions[0].status)
		assertFalse("live session must never be synthesized as ended",
			sessions.any { it.status == "ended" })
	}

	@Test
	fun sessionsDoesNotSynthesizeEndedForLiveTeam_crossBareQualifiedTransition() {
		// A thread persisted under the bare name ("api", pre-federation) against a live
		// team carrying the qualified name. The canonical join resolves the bare thread
		// key to the live team's value, so no phantom "ended". The load-normalize
		// primitive that upgrades the persisted key is asserted alongside.
		val localSwitchId = "switchboard"
		assertEquals("switchboard/api", TeamAddress.parse("api", localSwitchId).canonical)
		val state = stateWith(
			teams = listOf(makeTeam("switchboard/api", "online")),
			threads = mapOf("api" to listOf(makeMsg())),
			localSwitchId = localSwitchId,
		)
		val sessions = state.sessions(localSwitchId)
		assertEquals("must be exactly 1 session (no phantom ended)", 1, sessions.size)
		assertEquals("online", sessions[0].status)
		assertFalse("bare thread key must not synthesize ended against a qualified live team",
			sessions.any { it.status == "ended" })
	}

	@Test
	fun sessionsDoSynthesizeEndedForTrulyGoneTeam() {
		// A thread with no matching live team should still produce an "ended" entry.
		val localSwitchId = "switchboard"
		val state = stateWith(
			teams = emptyList(),
			threads = mapOf("switchboard/gone" to listOf(makeMsg())),
			localSwitchId = localSwitchId,
		)
		val sessions = state.sessions(localSwitchId)
		assertEquals(1, sessions.size)
		assertEquals("ended", sessions[0].status)
	}

	// -- Face-4 mis-thread tests (SessionId + NoticeId, no Android context needed) --

	@Test
	fun face4_sessionTailIsThisDevice_targetEqualsLocal() {
		// When the session tail resolves to the device itself, the Face-4 rule kicks in.
		// Verify that SessionId.parse produces a target equal to TeamAddress.local when
		// the session tail is the device name (qualified).
		val localSwitchId = "switchboard"
		val deviceName = "Pixel9"
		// An agent sends to the console's own session: conv:<conv>:switchboard/Pixel9
		val sessionId = "conv:abc123:switchboard/Pixel9"
		val sid = SessionId.parse(sessionId, localSwitchId)
		assertNotNull(sid)
		val thisDevice = TeamAddress.local(localSwitchId, deviceName)
		assertEquals("session tail must equal this device's TeamAddress",
			thisDevice, sid!!.target)
	}

	@Test
	fun face4_sessionTailIsOtherTeam_targetNotLocal() {
		// A normal agent->console conversation: the session tail is the agent team,
		// not this device. The Face-4 branch must NOT fire.
		val localSwitchId = "switchboard"
		val deviceName = "Pixel9"
		val sessionId = "conv:abc123:switchboard/my-project"
		val sid = SessionId.parse(sessionId, localSwitchId)
		assertNotNull(sid)
		val thisDevice = TeamAddress.local(localSwitchId, deviceName)
		assertFalse("session tail must not equal this device",
			sid!!.target == thisDevice)
	}

	@Test
	fun face4_bareDeviceNameDoesNotLiterallyMatchQualifiedTail() {
		// Confirms the fix: a bare deviceName string-equals check against a
		// qualified tail ("switchboard/Pixel9" vs "Pixel9") would silently miss.
		// The value-equals check via TeamAddress is correct; this test documents why.
		val localSwitchId = "switchboard"
		val deviceName = "Pixel9"
		val sessionId = "conv:abc123:switchboard/Pixel9"
		val sid = SessionId.parse(sessionId, localSwitchId)!!
		val tailLiteral = sessionId.substringAfterLast(':')
		assertFalse("bare deviceName must NOT equal the qualified tail string",
			tailLiteral == deviceName)
		// But value-compare via TeamAddress DOES match:
		val thisDevice = TeamAddress.local(localSwitchId, deviceName)
		assertEquals(thisDevice, sid.target)
	}

	// -- NoticeId routing --

	@Test
	fun noticeIdParsesAndProducesCanonicalSender() {
		val localSwitchId = "switchboard"
		val wire = "notice:switchboard/host-agent"
		val n = NoticeId.parse(wire, localSwitchId)
		assertNotNull(n)
		assertEquals("switchboard/host-agent", n!!.sender.canonical)
		assertEquals(wire, n.key)
	}

	@Test
	fun noticeIdBareFromIsNormalizedToCanonical() {
		val localSwitchId = "switchboard"
		val wire = "notice:host-agent"
		val n = NoticeId.parse(wire, localSwitchId)
		assertNotNull(n)
		// Bare sender normalizes to canonical under localSwitchId
		assertEquals("switchboard/host-agent", n!!.sender.canonical)
	}

	@Test
	fun sessionIdIsNotParsedAsNotice() {
		val localSwitchId = "switchboard"
		assertNull(NoticeId.parse("conv:c:switchboard/api", localSwitchId))
	}

	@Test
	fun noticeIdIsNotParsedAsSession() {
		val localSwitchId = "switchboard"
		assertNull(SessionId.parse("notice:switchboard/host-agent", localSwitchId))
	}

	// -- TeamAddress load-normalize round-trip --

	@Test
	fun teamAddressNormalizeBareKey() {
		val localSwitchId = "switchboard"
		val bare = "my-project"
		val canonical = TeamAddress.parse(bare, localSwitchId).canonical
		assertEquals("switchboard/my-project", canonical)
		// Idempotent: re-parsing the canonical produces the same result
		assertEquals(canonical, TeamAddress.parse(canonical, localSwitchId).canonical)
	}

	@Test
	fun sessionIdNormalizeBareThreadKey() {
		val localSwitchId = "switchboard"
		// A bare session key from a pre-migration persist (hypothetical; actual
		// persisted keys are team keys not session keys, but confirms the parser).
		val bare = "conv:abc:my-project"
		val sid = SessionId.parse(bare, localSwitchId)
		assertNotNull(sid)
		assertEquals("conv:abc:switchboard/my-project", sid!!.key)
	}
}
