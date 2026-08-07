package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry

/** One gateway's board snapshot, in the order sources should win ties (route gateway first). */
data class BoardSource(val gatewayId: String, val entries: List<BoardEntry>)

data class BoardRow(val entry: BoardEntry, val gatewayId: String, val depth: Int)

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

/** The ONE pure producer of board rows: its output guarantees each entry id appears at most once,
 * which every LazyColumn key depends on.
 *
 * Every live entry renders, in tree position. Finished branches used to collapse behind a count and
 * finished leaves used to gather at the bottom; both hid the shape of the work behind a tap. A
 * finished entry already reads as finished from its own state mark. */
fun flattenBoard(sources: List<BoardSource>, sessionGateway: (String) -> String? = { null }): BoardRows {
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

	/** The children a group's walk renders: a child claimed away to another session is a root of its
	 * own group, not a descendant here. */
	fun kidsIn(id: String, group: GroupKey?): List<Pair<BoardEntry, String>> =
		(childrenOf[id] ?: emptyList<Pair<BoardEntry, String>>()).filter { groupOf(it) == group }

	fun buildGroup(group: GroupKey?, roots: List<Pair<BoardEntry, String>>): BoardGroup {
		val rows = mutableListOf<BoardRow>()
		// Bad data with a parent cycle terminates on the visited set rather than hanging the UI.
		val visited = mutableSetOf<String>()

		fun walk(pair: Pair<BoardEntry, String>, depth: Int) {
			val (e, gw) = pair
			if (!visited.add(e.id)) return
			rows.add(BoardRow(e, gw, depth))
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
