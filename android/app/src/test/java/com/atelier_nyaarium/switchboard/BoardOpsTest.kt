package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.board.BoardManager
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter
import com.atelier_nyaarium.switchboard.board.BoardSealing
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

import org.junit.Assert.assertEquals
import org.junit.Test

class BoardOpsTest {
	private class FakeBoardStore : com.atelier_nyaarium.switchboard.board.BoardStore {
		var board: String? = null
		override fun loadTaskBoard() = board
		override fun saveTaskBoard(json: String) { board = json }
		override fun loadGatewayId() = "gw"
	}

	private class FakeCollaborators(store: FakeBoardStore) : BoardOpsCollaborators {
		override val board = BoardManager(store)
		override val sessions: SessionOps get() = error("unused")
		override val attachmentHost: AttachmentHost get() = error("unused")
		override val boardRouter = BoardRouterWriter(board, { _, _ -> error("unused") }, { error("unused") })
		override fun boardSealing(): BoardSealing? = null
		override fun admitPicked(uris: List<Uri>, name: String) = emptyList<OutgoingFile>() to null
		override fun localDomain() = "dom"
		override val client: ConsoleClient? = null
		override fun command(block: () -> Unit) = block()
	}

	@Test
	fun capturesShowOnTheBoardBeforeTheRouterAnswers() {
		val collaborators = FakeCollaborators(FakeBoardStore())
		val ops = BoardOps(MutableStateFlow(ChatState()), CoroutineScope(Dispatchers.Unconfined), File("/tmp/board-ops"), { "gw" }, collaborators)

		ops.boardCapture("first", null)
		ops.boardCapture("second", "why")

		val entries = ops.boardEntries()
		assertEquals(listOf("first", "second"), entries.map { it.title })
		assertEquals(listOf(null, "why"), entries.map { it.body })
		assertEquals(listOf("open", "open"), entries.map { it.state })
	}
}
