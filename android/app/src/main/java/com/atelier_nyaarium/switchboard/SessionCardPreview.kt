package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.board.BoardLiveLine

////////////////////////////////
//  Interfaces & Types

/**
 * What a session card's text rungs show, top down: the session's own last reply headline, its
 * unfinished board work, then the thread's newest row.
 *
 * A pure value rather than logic inside the composable, so the rules below are reachable from a unit
 * test. The composable renders a rung when its field is non-null and does nothing else.
 */
data class SessionCardPreview(
	val headline: String? = null,
	val headlineAt: Long? = null,
	val boardWork: BoardLiveLine? = null,
	val snippet: String? = null,
	val snippetAt: Long? = null,
)

////////////////////////////////
//  Functions & Helpers

/** Derive a card's rungs from the thread and the session's live board line. */
fun sessionCardPreview(state: ChatState, team: String, boardLine: BoardLiveLine?): SessionCardPreview {
	val boardWork = boardLine?.takeIf { it.finished < it.total }
	// Live board work displaces the relative time on every rung: the finished-over-total count answers
	// "is anything happening" better than a timestamp does.
	val timeAllowed = boardWork == null

	val reply = state.lastReply(team)
	val headline = oneLine(reply?.title)
	val lastRow = state.lastRow(team)

	// The snippet is suppressed only when it would repeat the headlined row back to itself. Keying that
	// on the ROW, not merely on a headline existing, is what keeps the owner's own send visible: after
	// they send, the headline is still the agent's older reply and the newest row is theirs, so the card
	// has to change or sending looks like it did nothing.
	val showSnippet = headline == null || lastRow?.id != reply?.id
	// A row carrying only files has no text to preview, and the card would otherwise show a lone
	// timestamp against blank space. Same stand-in the notification shade uses for that row.
	val snippet = (if (showSnippet) state.snippet(team) else null)
		?: ATTACHMENT_STANDIN.takeIf { showSnippet && lastRow?.files?.isNotEmpty() == true }

	return SessionCardPreview(
		headline = headline,
		// Stamped with the REPLY's own time, not the thread's newest activity: beside a specific
		// headline a thread-wide time reads as when that reply landed, and would say "1m" for an
		// hour-old headline just because the owner had since sent something.
		headlineAt = reply?.at?.takeIf { headline != null && timeAllowed },
		// Passed through raw. Cleaning it HERE would make this card disagree with the board strip and
		// the board tab, which render the same title from the same producer one tap away.
		boardWork = boardWork,
		snippet = snippet,
		// The thread's newest time, which is also what sessionOrder sorts on, so the card's LOWEST time
		// is its sort key and the column reads in order down the list. Never shown alone: a bare time
		// against empty space says less than nothing.
		snippetAt = state.lastActivity(team)?.takeIf { snippet != null && timeAllowed },
	)
}

/** Stands in for a row whose only content is files, on the card and in the notification shade alike. */
internal const val ATTACHMENT_STANDIN = "(attachment)"
