package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry

data class BoardRow(val entry: BoardEntry, val gatewayId: String, val depth: Int)

/** The Gateway an entry's session lives on, which is half a [GroupKey]. Empty for an unassigned one. */
private fun gatewayOf(entry: BoardEntry): String = entry.session?.gatewayId ?: ""

private fun groupOf(entry: BoardEntry): GroupKey? = entry.sessionId?.let { GroupKey(gatewayOf(entry), it) }

/** What identifies one session group. A stored `sessionId` is the bare local field, unique only
 * within its Gateway, so the Gateway is half the identity. */
data class GroupKey(val gatewayId: String, val sessionId: String)

/** One session's slice of the board, in tree order. */
data class BoardGroup(val key: GroupKey?, val rows: List<BoardRow>)

data class BoardRows(
	val unassigned: BoardGroup,
	val sessions: List<BoardGroup>,
	val trash: List<BoardRow>,
)

/** One line a session card draws. */
sealed interface CardRung {
	data class Entry(val row: BoardRow) : CardRung

	/** A contiguous run of finished entries, drawn as one line. */
	data class Finished(val count: Int, val depth: Int, val allDone: Boolean) : CardRung
}

/** What a session card draws, and how many entries it neither drew nor counted in a run. */
data class CardBranch(val rungs: List<CardRung>, val hidden: Int)

/** How many lines a session card will draw before it starts counting instead. A card is a glance;
 * past this the session list turns into a page of scrolling and the board tab is the better place. */
const val CARD_BRANCH_MAX = 6

private fun isFinished(row: BoardRow) = row.entry.state == "done" || row.entry.state == "cancelled"

/** Contiguous finished runs of two or more become one rung. A single finished entry stays itself,
 * since "1 done" costs the same line and says less than the title does. */
private fun collapseFinished(rows: List<BoardRow>): List<CardRung> {
	val out = mutableListOf<CardRung>()
	var i = 0
	while (i < rows.size) {
		if (!isFinished(rows[i])) {
			out.add(CardRung.Entry(rows[i]))
			i++
			continue
		}
		var end = i
		while (end < rows.size && isFinished(rows[end])) end++
		val run = rows.subList(i, end)
		if (run.size == 1) {
			out.add(CardRung.Entry(run[0]))
		} else {
			out.add(CardRung.Finished(run.size, run.minOf { it.depth }, run.all { it.entry.state == "done" }))
		}
		i = end
	}
	return out
}

/**
 * One branch of a session's tree: the top-level entry holding [currentId] and everything beneath it.
 *
 * `rows` is already in tree order with depth, so a branch is the slice from a depth-0 row up to the
 * next one. That is what makes this a pair of scans rather than a second walk over the parent
 * pointers, and it cannot disagree with what the board tab draws.
 *
 * An unknown or absent [currentId] falls back to the FIRST branch rather than to nothing: a session
 * whose current entry was just trashed still has work worth showing, and an empty card would read as
 * a session with no board at all.
 *
 * The card centers on where the work IS. A long finished run collapses to one rung, and what is left
 * is a window around [currentId] rather than the top of the branch: a prefix filled every slot with
 * finished entries and hid the one being worked on behind the count.
 */
fun cardBranchOf(rows: List<BoardRow>, currentId: String?, max: Int = CARD_BRANCH_MAX): CardBranch {
	if (rows.isEmpty()) return CardBranch(emptyList(), 0)
	val at = rows.indexOfFirst { it.entry.id == currentId }.takeIf { it >= 0 } ?: 0
	var start = at
	while (start > 0 && rows[start].depth != 0) start--
	var end = start + 1
	while (end < rows.size && rows[end].depth != 0) end++
	val branch = rows.subList(start, end)
	// The root is kept whatever else goes: it names what the work is, and a slice starting mid-tree
	// would show indented children hanging under nothing.
	val root = CardRung.Entry(branch.first())
	val rungs = listOf(root) + collapseFinished(branch.drop(1))
	val kept = if (rungs.size <= max) {
		rungs
	} else {
		val current = rungs.indexOfFirst { it is CardRung.Entry && it.row.entry.id == currentId }
		val window = (max - 1).coerceAtLeast(0)
		// One rung of lead-in where there is room, so the current entry is not pinned to the top edge.
		val first = (current - 1).coerceIn(1, (rungs.size - window).coerceAtLeast(1))
		listOf(root) + rungs.subList(first, (first + window).coerceAtMost(rungs.size))
	}
	val shown = kept.sumOf { if (it is CardRung.Finished) it.count else 1 }
	return CardBranch(kept, branch.size - shown)
}

/** The ONE pure producer of board rows: its output guarantees each entry id appears at most once,
 * which every LazyColumn key depends on.
 *
 * Every live entry renders, in tree position, never collapsed behind a count or gathered to the
 * bottom - either would hide the shape of the work behind a tap. A finished entry already reads as
 * finished from its own state mark. */
fun flattenBoard(entries: List<BoardEntry>): BoardRows {
	val live = entries.filter { it.trashedAt == null }
	val trash = entries
		.filter { it.trashedAt != null }
		.sortedByDescending { it.trashedAt }
		.map { BoardRow(it, gatewayOf(it), depth = 0) }

	val liveById = live.associateBy { it.id }
	val childrenOf = HashMap<String, MutableList<BoardEntry>>()
	for (e in live) {
		val parent = e.parent
		if (parent != null && liveById.containsKey(parent)) {
			childrenOf.getOrPut(parent) { mutableListOf() }.add(e)
		}
	}
	for (list in childrenOf.values) list.sortBy { it.rank }

	// A group's local roots: entries whose parent is absent, dead, or assigned elsewhere - a child
	// claimed away from an unassigned parent renders as a root of its own group.
	// The key carries the GATEWAY as well as the session: a stored sessionId is the bare local field,
	// which is unique only within one Gateway, so two machines running the same project.session would
	// otherwise merge into one group under whichever machine's label was found first.
	val groups = LinkedHashMap<GroupKey?, MutableList<BoardEntry>>()
	groups[null] = mutableListOf()
	for (e in live) {
		val parent = e.parent?.let { liveById[it] }
		val isRoot = parent == null || groupOf(parent) != groupOf(e)
		if (isRoot) groups.getOrPut(groupOf(e)) { mutableListOf() }.add(e)
	}
	for (list in groups.values) list.sortBy { it.rank }

	/** The children a group's walk renders: a child claimed away to another session is a root of its
	 * own group, not a descendant here. */
	fun kidsIn(id: String, group: GroupKey?): List<BoardEntry> =
		(childrenOf[id] ?: emptyList<BoardEntry>()).filter { groupOf(it) == group }

	fun buildGroup(group: GroupKey?, roots: List<BoardEntry>): BoardGroup {
		val rows = mutableListOf<BoardRow>()
		// Bad data with a parent cycle terminates on the visited set rather than hanging the UI.
		val visited = mutableSetOf<String>()

		fun walk(e: BoardEntry, depth: Int) {
			if (!visited.add(e.id)) return
			rows.add(BoardRow(e, gatewayOf(e), depth))
			for (kid in kidsIn(e.id, group)) walk(kid, depth + 1)
		}

		for (root in roots) walk(root, 0)
		return BoardGroup(group, rows)
	}

	val unassigned = buildGroup(null, groups[null] ?: emptyList())
	val sessions = groups.entries
		.mapNotNull { (key, value) -> key?.let { it to value } }
		.sortedWith(compareBy({ it.first.gatewayId }, { it.first.sessionId }))
		.map { buildGroup(it.first, it.second) }
	return BoardRows(unassigned, sessions, trash)
}
