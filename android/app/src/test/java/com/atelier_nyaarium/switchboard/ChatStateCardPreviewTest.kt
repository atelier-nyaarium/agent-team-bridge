package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.board.BoardLiveLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The session card's preview derivation: which row headlines a card, when the snippet rung shows
 * beneath it, and what each rung is stamped with. Asserts through sessionCardPreview rather than
 * through the ChatState getters, since the getters answer independently of which one a card reads.
 */
class ChatStateCardPreviewTest {
	private var nextId = 1L

	private fun inbound(text: String, title: String? = null, at: Long = 0, peer: Boolean = false) =
		Message(fromMe = false, text = text, at = at, id = nextId++, title = title, isPeer = peer)

	private fun sent(text: String, at: Long = 0) = Message(fromMe = true, text = text, at = at, id = nextId++)

	private fun preview(vararg rows: Message, board: BoardLiveLine? = null) =
		sessionCardPreview(ChatState(threads = mapOf(TEAM to rows.toList())), TEAM, board)

	@Test
	fun theHeadlineIsTheSessionsLatestReply() {
		val p = preview(inbound("older", title = "Older headline"), inbound("newer", title = "Newer headline"))
		assertEquals("Newer headline", p.headline)
	}

	@Test
	fun aNewerUntitledReplyRetiresAnOlderHeadlineRatherThanHidingBehindIt() {
		// Scanning back for any titled row would headline something the session has moved on from and
		// hide what it actually said last. No headline is what lets the snippet rung show the newer row.
		val p = preview(inbound("older", title = "Older headline"), inbound("a structured answer, no title"))
		assertNull(p.headline)
		assertEquals("a structured answer, no title", p.snippet)
	}

	@Test
	fun aPeerMirrorNeverHeadlinesButStillCountsAsSomethingHappening() {
		// One agent talking to another is not the session's word to the owner, so it cannot take the
		// headline. It is still the thread's newest row, so the snippet rung reports it.
		val p = preview(inbound("reply", title = "The headline"), inbound("agent chatter", peer = true))
		assertEquals("The headline", p.headline)
		assertEquals("agent chatter", p.snippet)
	}

	@Test
	fun aMultiLineTitleCollapsesRatherThanLosingItsTail() {
		// A notice title may carry real newlines, and the headline rung is one ellipsized line, so
		// without the collapse everything after the first break is dropped with no other signal.
		val p = preview(inbound("body", title = "Build failed\n2 auth tests"))
		assertEquals("Build failed 2 auth tests", p.headline)
	}

	@Test
	fun aMultiLineBodyCollapsesOnTheSnippetRungToo() {
		// The body is the rung that actually carries prose, and it is one ellipsized line. Without the
		// collapse a reply reads as its first line alone, and one starting with a break reads as blank.
		val p = preview(inbound("Done.\n\nDetails: the auth tests now pass"))
		assertEquals("Done. Details: the auth tests now pass", p.snippet)
	}

	@Test
	fun aFileOnlyReplyNamesItselfRatherThanLeavingTheCardBlank() {
		// A design-card push with no message carries files and no text. Without a stand-in the card
		// shows a lone timestamp against empty space, moments after the session said something.
		val row = Message(
			fromMe = false,
			text = "",
			at = 5_000,
			id = nextId++,
			files = listOf(MessageFile(name = "editor-form.html", mime = "text/html")),
		)
		val p = sessionCardPreview(ChatState(threads = mapOf(TEAM to listOf(row))), TEAM, null)
		assertEquals("(attachment)", p.snippet)
		assertEquals(5_000L, p.snippetAt)
	}

	@Test
	fun aTextlessRowWithNoFilesShowsNoTimeEither() {
		// A bare relative time against blank space says less than nothing.
		val p = preview(inbound("", at = 5_000))
		assertNull(p.snippet)
		assertNull(p.snippetAt)
	}

	@Test
	fun aThreadWithNoInboundRowsHeadlinesNothing() {
		assertNull(preview(sent("only my own")).headline)
		assertNull(sessionCardPreview(ChatState(), TEAM, null).headline)
	}

	@Test
	fun theHeadlineCarriesItsOwnReplysTimeNotTheThreadsNewest() {
		// A thread-wide stamp would say "just now" for an hour-old headline whenever the owner had
		// since sent something.
		val p = preview(inbound("reply", title = "The headline", at = 1_000), sent("later", at = 9_000))
		assertEquals(1_000L, p.headlineAt)
	}

	@Test
	fun sendingSomethingChangesTheCard() {
		// The owner's own send cannot retire the headline, so without the snippet rung beneath it the
		// card would be byte-identical to before they sent and nothing would confirm it went.
		val before = preview(inbound("reply", title = "The headline", at = 1_000))
		assertNull(before.snippet)
		assertNull(before.snippetAt)

		val after = preview(inbound("reply", title = "The headline", at = 1_000), sent("my follow-up", at = 9_000))
		assertEquals("The headline", after.headline)
		assertEquals("my follow-up", after.snippet)
		assertEquals(9_000L, after.snippetAt)
	}

	@Test
	fun theLowestTimeOnACardIsWhatTheListSortsOn() {
		// sessionOrder ranks by lastActivity, the thread's MAX time, which is not the last row's time:
		// rows append in arrival order and only a persisted load re-sorts them, so a server-stamped
		// row landing behind an optimistic echo under clock skew is enough to separate the two. Reading
		// the last row's stamp instead would leave the card's lowest time out of step with its rank.
		val p = preview(inbound("reply", title = "The headline", at = 9_000), sent("later", at = 4_000))
		assertEquals(9_000L, p.snippetAt)
	}

	@Test
	fun anUntitledReplyCarriesNoHeadlineTimeForARungThatIsNotThere() {
		// headlineAt is a field on a public value, not something only SessionCard reads: handing back a
		// stamp for a headline that does not render invites a second consumer to paint it alone.
		val p = preview(inbound("a structured answer, no title", at = 1_000))
		assertNull(p.headline)
		assertNull(p.headlineAt)
	}

	@Test
	fun theBoardRungCollapsesLikeTheBoardStripsOwnSingleLineRows() {
		val messy = BoardLiveLine(title = "Fix the login bug\nand the logout one", state = "open", finished = 0, total = 2)
		val p = preview(inbound("reply", title = "The headline"), board = messy)
		assertEquals("Fix the login bug and the logout one", p.boardWork?.title)
	}

	@Test
	fun theHeadlineAloneShowsWhenItIsAlsoTheNewestRow() {
		// Repeating the headlined row underneath itself says nothing twice.
		val p = preview(inbound("older", title = "Older"), inbound("newest", title = "The headline"))
		assertEquals("The headline", p.headline)
		assertNull(p.snippet)
		assertNull(p.snippetAt)
	}

	@Test
	fun liveBoardWorkTakesTheRelativeTimeOffEveryRung() {
		// A finished-over-total count answers "is anything happening" better than a timestamp does.
		val busy = BoardLiveLine(title = "Build the thing", state = "in_progress", finished = 1, total = 3)
		val p = preview(inbound("reply", title = "The headline", at = 1_000), sent("later", at = 9_000), board = busy)
		assertEquals("The headline", p.headline)
		assertNull(p.headlineAt)
		assertNull(p.snippetAt)
		assertEquals(busy, p.boardWork)
	}

	@Test
	fun aFinishedBoardLineIsNotLiveWorkAndGivesTheTimeBack() {
		val done = BoardLiveLine(title = "Build the thing", state = "done", finished = 3, total = 3)
		val p = preview(inbound("reply", title = "The headline", at = 1_000), board = done)
		assertNull(p.boardWork)
		assertEquals(1_000L, p.headlineAt)
	}

	companion object {
		private const val TEAM = "proj.main"
	}
}
