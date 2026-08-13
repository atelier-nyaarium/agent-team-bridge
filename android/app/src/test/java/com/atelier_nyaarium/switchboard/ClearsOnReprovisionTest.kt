package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.board.BoardManager
import com.atelier_nyaarium.switchboard.board.BoardStore
import com.atelier_nyaarium.switchboard.board.BoardWriter
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Clear & re-provision may hand the device to a DIFFERENT owner, and the process is not restarted:
 * Repo.get memoizes ChatRepository for the app's lifetime, so every delegate it holds survives the
 * wipe with the previous owner's data still in it.
 */
class ClearsOnReprovisionTest {
	/** In-memory storage. [wipe] is what clearProvisioning does to the board: KEY_TASK_BOARD is in
	 * PROVISIONING_KEYS, so the durable half is gone and only the in-memory copy remains. */
	private class FakeStore : BoardStore {
		var blob: String? = null

		fun wipe() {
			blob = null
		}

		override fun loadTaskBoard(): String? = blob

		override fun saveTaskBoard(json: String) {
			blob = json
		}

		override fun loadGatewayId(): String = "gw-route"
	}

	private object RefusingWriter : BoardWriter {
		override suspend fun boardWrite(op: ConsoleOp, gatewayId: String, opId: String): List<String> =
			throw BoardRefused("entry_missing")
	}

	private fun entry(id: String) = BoardEntry(id = id, title = "t-$id", state = "open", rank = "m")

	@Test
	fun theNextOwnersFirstWriteDoesNotRePersistThePreviousOwnersBoard() = runBlocking {
		val store = FakeStore()
		val board = BoardManager(store)
		board.applySnapshot("gw-theirs", listOf(entry("theirs")), version = null, truncated = false)
		board.enqueue(ConsoleOp.BoardSetState("theirs", "done"), "gw-theirs")
		assertTrue(store.blob!!.contains("theirs"))

		store.wipe()
		board.clearInMemory()

		// A write is what persists the blob, so this is the moment the old board would come back.
		board.enqueue(ConsoleOp.BoardSetState("mine", "done"), "gw-route")

		assertTrue(board.mergedEntries("gw-theirs").isEmpty())
		assertEquals(listOf("gw-route"), board.queuedActions.map { it.gatewayId })
		assertFalse("the previous owner's board must not be re-persisted", store.blob!!.contains("theirs"))
	}

	@Test
	fun theNextOwnerDoesNotInheritNoticesTheyCannotAct() = runBlocking {
		val store = FakeStore()
		val board = BoardManager(store)
		board.enqueue(ConsoleOp.BoardSetState("theirs", "done"), "gw-route")
		board.drain(RefusingWriter)
		assertEquals(1, board.refusals.size)

		store.wipe()
		board.clearInMemory()

		assertTrue(board.refusals.isEmpty())
	}

	/**
	 * The roster ([ChatRepository.clearedOnReprovision]) is instance-side, so pin the field set it has
	 * to name. A delegate that states its own wipe and is then left out of the roster fails here; one
	 * that holds state and never implements [ClearsOnReprovision] is invisible to both.
	 */
	@Test
	fun everyRepositoryFieldDeclaringAWipeIsInTheRoster() {
		val declared = ChatRepository::class.java.declaredFields
			.filter { ClearsOnReprovision::class.java.isAssignableFrom(it.type) }
			.map { it.name }
			.toSet()
		assertEquals(setOf("board", "presence", "trust", "drain"), declared)
	}
}
