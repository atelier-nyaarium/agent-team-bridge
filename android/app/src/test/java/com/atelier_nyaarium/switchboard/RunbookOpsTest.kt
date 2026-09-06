package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookParameter
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Test

class RunbookOpsTest {
	private class NoGateway : RunbookHost {
		override val client: ConsoleClient? = null
		override fun homeGatewayId() = ""
	}

	private fun book(id: String, name: String = id, revision: Long = 1L) = Runbook(
		id = id,
		name = name,
		body = "cut a {{level}} release",
		parameters = listOf(RunbookParameter(name = "level", label = "Level", kind = "text")),
		revision = revision,
	)

	private fun opsOver(library: List<Runbook>): Pair<RunbookOps, MutableStateFlow<ChatState>> {
		val state = MutableStateFlow(ChatState(runbooks = library))
		return RunbookOps(state, NoGateway()) to state
	}

	@Test
	fun savingOrdersByNameAndKeepsTheHigherRevision() {
		val (ops, state) = opsOver(listOf(book("b", name = "Zebra"), book("a", name = "Apple")))

		ops.save(book("c", name = "Apple"))
		assertEquals(listOf("a", "c", "b"), state.value.runbooks.map { it.id })

		ops.save(book("a", name = "Apple", revision = 4L))
		assertEquals(4L, state.value.runbooks.first { it.id == "a" }.revision)

		ops.save(book("a", name = "Apple", revision = 2L))
		assertEquals(4L, state.value.runbooks.first { it.id == "a" }.revision)
	}

	@Test
	fun aGatewayIsGivenTheLibrarysCopyUnlessItAlreadyHoldsThatExactOne() {
		val mine = book("a", revision = 3L)
		assertEquals(PushDecision.Put, pushDecision(mine, null))
		assertEquals(PushDecision.Put, pushDecision(mine, book("a", revision = 2L)))
		assertEquals(PushDecision.Ready, pushDecision(mine, mine))

		// Equal revisions carrying different words are a lost update, which the Gateway refuses.
		assertEquals(PushDecision.Put, pushDecision(mine, book("a", name = "Renamed", revision = 3L)))

		val theirs = book("a", revision = 9L)
		assertEquals(PushDecision.Adopt(theirs), pushDecision(mine, theirs))
	}

	@Test
	fun deletingTakesItOutOfTheLibraryEvenWithNoGatewayToTell() {
		val (ops, state) = opsOver(listOf(book("a"), book("b")))
		kotlinx.coroutines.runBlocking { ops.delete("a") }
		assertEquals(listOf("b"), state.value.runbooks.map { it.id })
	}

	@Test
	fun firingWithoutAGatewayAnswersNothingRatherThanThrowing() {
		val (ops, _) = opsOver(listOf(book("a")))
		val answer = kotlinx.coroutines.runBlocking {
			ops.fire("a", emptyMap(), com.atelier_nyaarium.switchboard.proto.RunbookFireTarget.Session("host.x"), 1L)
		}
		assertEquals(null, answer)
	}
}
