package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry

/** One gateway's board snapshot, in the order sources should win ties (route gateway first). */
data class BoardSource(val gatewayId: String, val entries: List<BoardEntry>)

/** One rendered row. `foldedCount` > 0 marks a fully-finished branch collapsed onto this row;
 * `gathered` marks a loose finished entry shown in the bottom gather instead of tree position. */
data class BoardRow(
	val entry: BoardEntry,
	val gatewayId: String,
	val depth: Int,
	val foldedCount: Int = 0,
	val gathered: Boolean = false,
	// True on a fold point the owner has opened. Its foldedCount is 0 (nothing is hidden), so this
	// is what keeps the row's tap re-collapsing rather than opening the editor.
	val foldExpanded: Boolean = false,
)

/** What identifies one session group. A stored `sessionId` is the bare local field, unique only
 * within its Gateway, so the Gateway is half the identity. */
data class GroupKey(val gatewayId: String, val sessionId: String)

/** One session's slice of the board, plus how many finished entries its gather is hiding. */
data class BoardGroup(
	val key: GroupKey?,
	val rows: List<BoardRow>,
	val gatheredRows: List<BoardRow>,
)

data class BoardRows(
	val unassigned: BoardGroup,
	val sessions: List<BoardGroup>,
	val trash: List<BoardRow>,
)

private fun isFinished(e: BoardEntry): Boolean = e.state == "done" || e.state == "cancelled"

/** The ONE pure producer of board rows: its output guarantees each entry id appears at most once,
 * which every LazyColumn key depends on. Branch-fold wins over the bottom gather where both apply. */
fun flattenBoard(
	sources: List<BoardSource>,
	sessionGateway: (String) -> String? = { null },
	expandedFolds: Set<String> = emptySet(),
): BoardRows {
	val winners = LinkedHashMap<String, Pair<BoardEntry, String>>()
	for (source in sources) {
		for (e in source.entries) {
			val current = winners[e.id]
			if (current == null) {
				winners[e.id] = e to source.gatewayId
				continue
			}
			val (cur, curGateway) = current
			val curTrashed = cur.trashedAt != null
			val newTrashed = e.trashedAt != null
			val newWins = when {
				curTrashed != newTrashed -> curTrashed
				else -> e.sessionId != null && sessionGateway(e.sessionId) == source.gatewayId &&
					sessionGateway(cur.sessionId ?: "") != curGateway
			}
			if (newWins) winners[e.id] = e to source.gatewayId
		}
	}

	val live = winners.values.filter { it.first.trashedAt == null }
	val trash = winners.values
		.filter { it.first.trashedAt != null }
		.sortedByDescending { it.first.trashedAt }
		.map { (e, gw) -> BoardRow(e, gw, depth = 0) }

	val liveById = live.associateBy { it.first.id }
	val childrenOf = HashMap<String, MutableList<Pair<BoardEntry, String>>>()
	for (pair in live) {
		val parent = pair.first.parent
		if (parent != null && liveById.containsKey(parent)) {
			childrenOf.getOrPut(parent) { mutableListOf() }.add(pair)
		}
	}
	for (list in childrenOf.values) list.sortBy { it.first.rank }

	// A group's local roots: entries whose parent is absent, dead, or assigned elsewhere - a child
	// claimed away from an unassigned parent renders as a root of its own group.
	// The key carries the GATEWAY as well as the session: a stored sessionId is the bare local field,
	// which is unique only within one Gateway, so two machines running the same project.session would
	// otherwise merge into one group under whichever machine's label was found first.
	fun groupOf(pair: Pair<BoardEntry, String>): GroupKey? =
		pair.first.sessionId?.let { GroupKey(pair.second, it) }
	val groups = LinkedHashMap<GroupKey?, MutableList<Pair<BoardEntry, String>>>()
	groups[null] = mutableListOf()
	val pairById = live.associateBy { it.first.id }
	for (pair in live) {
		val parent = pair.first.parent?.let { pairById[it] }
		val isRoot = parent == null || groupOf(parent) != groupOf(pair)
		if (isRoot) groups.getOrPut(groupOf(pair)) { mutableListOf() }.add(pair)
	}
	for (list in groups.values) list.sortBy { it.first.rank }

	/** The children a group's walk would actually render. Both fold questions filter by it, or a
	 * child claimed away to another session decides a fold the expansion can never deliver. */
	fun kidsIn(id: String, group: GroupKey?): List<Pair<BoardEntry, String>> =
		(childrenOf[id] ?: emptyList<Pair<BoardEntry, String>>()).filter { groupOf(it) == group }

	/** True when every member of the subtree is finished (the fold precondition). Bad data with a
	 * parent cycle terminates via the visited set rather than hanging the UI. */
	fun subtreeFinished(id: String, group: GroupKey?, visited: MutableSet<String>): Boolean {
		if (!visited.add(id)) return true
		val entry = liveById[id]?.first ?: return true
		if (!isFinished(entry)) return false
		return kidsIn(id, group).all { subtreeFinished(it.first.id, group, visited) }
	}

	fun subtreeSize(id: String, group: GroupKey?, visited: MutableSet<String>): Int {
		if (!visited.add(id)) return 0
		return 1 + kidsIn(id, group).sumOf { subtreeSize(it.first.id, group, visited) }
	}

	fun buildGroup(group: GroupKey?, roots: List<Pair<BoardEntry, String>>): BoardGroup {
		val rows = mutableListOf<BoardRow>()
		val gathered = mutableListOf<BoardRow>()

		fun walk(pair: Pair<BoardEntry, String>, depth: Int, insideExpandedFold: Boolean) {
			val (e, gw) = pair
			val kids = kidsIn(e.id, group)
			if (isFinished(e) && subtreeFinished(e.id, group, mutableSetOf())) {
				val hidden = subtreeSize(e.id, group, mutableSetOf()) - 1
				if (hidden > 0 && e.id !in expandedFolds) {
					rows.add(BoardRow(e, gw, depth, foldedCount = hidden))
					return
				}
				// A childless finished leaf gathers at the bottom - unless it sits inside an
				// expanded fold, where the person just asked to see the branch in place.
				if (hidden == 0 && !insideExpandedFold) {
					gathered.add(BoardRow(e, gw, depth = 0, gathered = true))
					return
				}
				rows.add(BoardRow(e, gw, depth, foldExpanded = e.id in expandedFolds))
				for (kid in kids) walk(kid, depth + 1, insideExpandedFold = true)
				return
			}
			rows.add(BoardRow(e, gw, depth))
			for (kid in kids) walk(kid, depth + 1, insideExpandedFold)
		}

		for (root in roots) walk(root, 0, insideExpandedFold = false)
		return BoardGroup(group, rows, gathered)
	}

	val unassigned = buildGroup(null, groups[null] ?: emptyList())
	val sessions = groups.entries
		.mapNotNull { (key, value) -> key?.let { it to value } }
		.sortedWith(compareBy({ it.first.gatewayId }, { it.first.sessionId }))
		.map { buildGroup(it.first, it.second) }
	return BoardRows(unassigned, sessions, trash)
}
