package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GoalOpsTest {
	private class FakeSessions(private val state: MutableStateFlow<ChatState>) : GoalOpsCollaborators {
		val sends = mutableListOf<String>()
		val typed = mutableListOf<Pair<String?, String?>>()
		override suspend fun send(team: String, text: String, uris: List<Uri>): String {
			sends += text
			state.value = state.value.copy(threads = mapOf(team to listOf(Message(true, text, 1L, status = "pending", opId = "op"))))
			return "op"
		}
		override suspend fun peekTerminal(team: String) = Result.success(ConsolePeekResult(hash = "h", ansi = "Claude Code\n❯ "))
		override suspend fun tmuxSend(team: String, text: String?, key: String?, submit: Boolean) { typed += text to key }
	}

	@Test
	fun armPersistsTheGoalAndDrivesTheTerminal() = runBlocking {
		val state = MutableStateFlow(ChatState())
		val fake = FakeSessions(state)
		val ops = GoalOps(state, ChatPersistence(testStore()), CoroutineScope(Dispatchers.Unconfined), fake)

		assertTrue(ops.armAndSend("local.gw.host.session", "  ship  it ", "message", emptyList()))

		assertEquals("message", fake.sends.single())
		assertEquals(listOf("/goal ", "ship it", null), fake.typed.map { it.first })
		assertEquals(emptyMap<String, PendingGoal>(), state.value.goals)
	}
}
