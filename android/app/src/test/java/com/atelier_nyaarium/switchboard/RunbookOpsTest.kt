package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookParameter
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Test

class RunbookOpsTest {
	private class MemoryStore : com.atelier_nyaarium.switchboard.runbooks.RunbookStore {
		private var blob: String? = null
		override fun loadRunbooks() = blob
		override fun saveRunbooks(json: String) { blob = json }
	}

	private class NoGateway(store: MemoryStore = MemoryStore()) : RunbookHost {
		override val client: ConsoleClient? = null
		override fun homeGatewayId() = ""
		override val library = com.atelier_nyaarium.switchboard.runbooks.RunbookManager(store)
	}

	private fun book(id: String, name: String = id, revision: Long = 1L) = Runbook(
		id = id,
		name = name,
		body = "cut a {{level}} release",
		parameters = listOf(RunbookParameter(name = "level", label = "Level", kind = "text")),
		revision = revision,
	)

	private fun opsOver(library: List<Runbook>): Pair<RunbookOps, MutableStateFlow<ChatState>> {
		val state = MutableStateFlow(ChatState())
		val host = NoGateway()
		host.library.merge(library)
		return RunbookOps(state, host) to state
	}

	@Test
	fun savingWithNoGatewayKeepsTheCopyAndSaysItIsLocal() {
		val (ops, state) = opsOver(listOf(book("b", name = "Zebra"), book("a", name = "Apple")))

		assertEquals(RunbookSaved.Local, kotlinx.coroutines.runBlocking { ops.save(book("c", name = "Apple")) })
		assertEquals(listOf("a", "c", "b"), state.value.runbooks.map { it.id })

		kotlinx.coroutines.runBlocking { ops.save(book("a", name = "Apple", revision = 4L)) }
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
	fun aRefusedPushIsAConflictTheOwnerCanRebaseOn() {
		val refused = ConsoleRunbookPutResult(stored = false, revision = 7L, reason = "held newer")
		val raised = conflictsAfterPut(emptyMap(), "a", refused)
		assertEquals(RunbookConflict("held newer", 7L), raised["a"])

		// An unreachable Gateway is not evidence the conflict went away.
		assertEquals(raised, conflictsAfterPut(raised, "a", null))
		assertEquals(emptyMap<String, RunbookConflict>(), conflictsAfterPut(raised, "a", refused.copy(stored = true)))
	}

	@Test
	fun aSaveTheLibraryDidNotTakeIsAConflictRatherThanASilentLoss() {
		val (ops, _) = opsOver(listOf(book("a", revision = 4L)))

		// The editor opened at 3 and something newer landed underneath it.
		val saved = kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 4L).copy(body = "stale")) }
		assertEquals(RunbookSaved.Refused(RunbookConflict("This phone holds a newer copy", 4L)), saved)
	}

	@Test
	fun aGatewaysRefusalIsReadFromItsOwnAnswer() {
		val refused = ConsoleRunbookPutResult(stored = false, revision = 7L, reason = "held newer")
		assertEquals(RunbookConflict("held newer", 7L), conflictOfRefusal(refused))
		assertEquals(7L, conflictOfRefusal(refused.copy(reason = null)).heldRevision)
	}

	@Test
	fun aConflictBelowTheDraftIsSpentSoTheEditorStopsOfferingIt() {
		val conflict = RunbookConflict("held newer", 7L)
		assertEquals(conflict, standingConflict(conflict, 7L))
		// Rebasing onto 7 from 8 would mint 8 again, which the library's merge would discard.
		assertEquals(null, standingConflict(conflict, 8L))
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
