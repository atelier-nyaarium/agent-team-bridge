package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry

data class BoardRow(val entry: BoardEntry, val gatewayId: String, val depth: Int)

private fun gatewayOf(entry: BoardEntry): String = entry.session?.gatewayId ?: ""

private fun groupOf(entry: BoardEntry): GroupKey? = entry.sessionId?.let { GroupKey(gatewayOf(entry), it) }

/** Session ids are scoped by gateway. */
data class GroupKey(val gatewayId: String, val sessionId: String)

data class BoardGroup(val key: GroupKey?, val rows: List<BoardRow>)

data class BoardRows(
	val unassigned: BoardGroup,
	val sessions: List<BoardGroup>,
	val trash: List<BoardRow>,
)

sealed interface CardRung {
	data class Entry(val row: BoardRow) : CardRung

	data class Finished(val count: Int, val depth: Int, val allDone: Boolean) : CardRung
}

data class CardBranch(val rungs: List<CardRung>, val hidden: Int)

const val CARD_BRANCH_MAX = 6

private fun isFinished(row: BoardRow) = row.entry.state == "done" || row.entry.state == "cancelled"

/** Finished runs of two or more collapse. */
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

/** Unknown current entries use the first branch. */
fun cardBranchOf(rows: List<BoardRow>, currentId: String?, max: Int = CARD_BRANCH_MAX): CardBranch {
	if (rows.isEmpty()) return CardBranch(emptyList(), 0)
	val at = rows.indexOfFirst { it.entry.id == currentId }.takeIf { it >= 0 } ?: 0
	var start = at
	while (start > 0 && rows[start].depth != 0) start--
	var end = start + 1
	while (end < rows.size && rows[end].depth != 0) end++
	val branch = rows.subList(start, end)
	// Always retain the branch root.
	val root = CardRung.Entry(branch.first())
	val rungs = listOf(root) + collapseFinished(branch.drop(1))
	val kept = if (rungs.size <= max) {
		rungs
	} else {
		val current = rungs.indexOfFirst { it is CardRung.Entry && it.row.entry.id == currentId }
		val window = (max - 1).coerceAtLeast(0)
		// Leave one rung before the current entry.
		val first = (current - 1).coerceIn(1, (rungs.size - window).coerceAtLeast(1))
		listOf(root) + rungs.subList(first, (first + window).coerceAtMost(rungs.size))
	}
	val shown = kept.sumOf { if (it is CardRung.Finished) it.count else 1 }
	return CardBranch(kept, branch.size - shown)
}

/** Each entry id appears at most once. */
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

	// Cross-group children become roots.
	// Group keys include gateway ids.
	val groups = LinkedHashMap<GroupKey?, MutableList<BoardEntry>>()
	groups[null] = mutableListOf()
	for (e in live) {
		val parent = e.parent?.let { liveById[it] }
		val isRoot = parent == null || groupOf(parent) != groupOf(e)
		if (isRoot) groups.getOrPut(groupOf(e)) { mutableListOf() }.add(e)
	}
	for (list in groups.values) list.sortBy { it.rank }

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
