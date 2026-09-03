package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.SessionKey
import com.atelier_nyaarium.switchboard.proto.parseStoreKey
import com.atelier_nyaarium.switchboard.proto.parseTarget
import com.atelier_nyaarium.switchboard.proto.storeKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the presence-join and thread-attribution behavior under the unified address
 * grammar. Team names and thread keys are both the canonical `domain.gateway.spawn.session` address
 * now, so the join is a direct equality and the gateway-minted session_id parses straight to that
 * canonical (no bare-vs-qualified repair, no Face-4 device/agent confusion).
 *
 * Pure data-class + value-object logic, no Android context (no Robolectric).
 */
class ChatStateSessionsTest {

	// -- Helper builders --

	private fun makeTeam(name: String, status: String = "online") =
		testTeam(name = name, status = status, mode = "channel")

	private fun makeMsg(text: String = "hello") =
		Message(fromMe = false, text = text, at = 1000L)

	private fun stateWith(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		homeGatewayId: String = "",
	) = ChatState(
		teams = teams,
		threads = threads,
		homeGatewayId = homeGatewayId,
	)

	// -- Presence join --

	@Test
	fun sessionsDoesNotSynthesizeEndedForLiveTeam() {
		// Team name and thread key are the SAME canonical address, so the join is a direct hit and no
		// phantom "ended" entry is synthesized for a live team.
		val canonical = "local.sakura.api.claude"
		val state = stateWith(
			teams = listOf(makeTeam(canonical, "online")),
			threads = mapOf(canonical to listOf(makeMsg())),
			homeGatewayId = "sakura",
		)
		val sessions = state.sessions()
		assertEquals(1, sessions.size)
		assertTrue(sessions[0].presence.isOnline)
		assertFalse(
			"live session must never be synthesized as ended",
			sessions.any { it.presence.hasEnded },
		)
	}

	@Test
	fun sessionsDoSynthesizeEndedForTrulyGoneTeam() {
		// A thread with no matching live team still produces an "ended" entry.
		val state = stateWith(
			teams = emptyList(),
			threads = mapOf("local.sakura.gone.claude" to listOf(makeMsg())),
			homeGatewayId = "sakura",
		)
		val sessions = state.sessions()
		assertEquals(1, sessions.size)
		assertTrue(sessions[0].presence.hasEnded)
	}

	// -- The join backbone: a gateway-minted conv session_id parses straight to the team's canonical --

	@Test
	fun inboundConvSessionThreadsToItsLiveTeam() {
		// The gateway's session_id for a chat is conv.<conv>.<domain>.<gateway>.<spawn>.<session>; the
		// console threads by address.canonical, which equals the team's name -> no phantom ended.
		val addr = Address.of("local", "sakura", "api", "claude")
		val sessionId = storeKey(SessionKey.Conv("conv-1", addr))
		val parsed = parseStoreKey(sessionId)
		assertTrue(parsed is SessionKey.Conv)
		val threadKey = (parsed as SessionKey.Conv).address.canonical
		val state = stateWith(
			teams = listOf(makeTeam(addr.canonical, "online")),
			threads = mapOf(threadKey to listOf(makeMsg())),
			homeGatewayId = "sakura",
		)
		val sessions = state.sessions()
		assertEquals("must be exactly 1 session (no phantom ended)", 1, sessions.size)
		assertTrue(sessions[0].presence.isOnline)
		assertFalse(sessions.any { it.presence.hasEnded })
	}

	// -- Notice routing: the notice store key threads under the sender's canonical address --

	@Test
	fun noticeStoreKeyParsesToCanonicalSender() {
		val sender = Address.of("local", "sakura", "host-agent", "claude")
		val key = storeKey(SessionKey.Notice(sender))
		val parsed = parseStoreKey(key)
		assertTrue(parsed is SessionKey.Notice)
		assertEquals("local.sakura.host-agent.claude", (parsed as SessionKey.Notice).sender.canonical)
		assertEquals(key, storeKey(parsed))
	}

	@Test
	fun convSessionIsNotParsedAsNotice() {
		val addr = Address.of("local", "sakura", "api", "claude")
		assertTrue(parseStoreKey(storeKey(SessionKey.Conv("c", addr))) is SessionKey.Conv)
	}

	// -- Face-4 grammar fact: an agent->console push carries the DEVICE address, not the agent's --

	@Test
	fun face4_deviceSessionVsAgentSession() {
		val device = Address.of("local", "sakura", "pixel9", "claude")
		val agent = Address.of("local", "sakura", "my-project", "claude")
		// A push TO the console's own session: the session address IS this device, so the poll loop
		// threads it under `from` (the sender) instead of under ourselves.
		val toDevice = parseStoreKey(storeKey(SessionKey.Conv("c", device))) as SessionKey.Conv
		assertEquals(device, toDevice.address)
		// A normal agent->console conversation: the session address is the agent, not the device.
		val fromAgent = parseStoreKey(storeKey(SessionKey.Conv("c", agent))) as SessionKey.Conv
		assertNotEquals(device, fromAgent.address)
	}

	// -- The spawn dialog's local `spawn.session` canonicalizes to the same key the board/threads use --

	@Test
	fun localTeamFieldResolvesToBoardCanonical() {
		val t = parseTarget("api.claude", "local", "sakura")
		assertTrue(t is Address)
		assertEquals("local.sakura.api.claude", t.canonical)
		// Idempotent: re-parsing the canonical (arity 4) yields the same value.
		assertEquals("local.sakura.api.claude", parseTarget("local.sakura.api.claude", "other", "other").canonical)
	}
}
