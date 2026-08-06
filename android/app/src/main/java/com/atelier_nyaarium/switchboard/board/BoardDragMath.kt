package com.atelier_nyaarium.switchboard.board

/** One visible row's vertical extent, as LazyListState.layoutInfo reports it. Only VISIBLE rows
 * exist: a LazyColumn disposes the rest, which is why the x-axis tab math (which needs every slot's
 * bounds) cannot be ported here. */
data class RowSpan(val id: String, val top: Int, val height: Int) {
	val center: Int get() = top + height / 2
}

/** Where a drag would land: the new parent (null = top level) and the rank to mint between the
 * resolved siblings. Null when the drop is a no-op or the target cannot be resolved. */
data class BoardDrop(val id: String, val parent: String?, val rank: String)

/**
 * The drop target for a row dragged to `pointerY`, resolved against the FLATTENED rows (each of
 * which knows its parent and depth) rather than a flat index - a visible neighbour may sit at a
 * different depth, or be a folded branch hiding real siblings, so "between my two visible
 * neighbours" is not the same as "between two siblings".
 *
 * The rule: find the row the pointer is over, take ITS parent as the destination, and mint between
 * that parent's actual children on either side of the drop.
 */
fun boardDropTarget(
	draggedId: String,
	pointerY: Int,
	visible: List<RowSpan>,
	rows: List<BoardRow>,
): BoardDrop? {
	if (visible.isEmpty()) return null
	val byId = rows.associateBy { it.entry.id }
	val dragged = byId[draggedId] ?: return null

	// The row whose span contains the pointer, else the nearest edge row.
	val over = visible.firstOrNull { pointerY >= it.top && pointerY < it.top + it.height }
		?: if (pointerY < visible.first().top) visible.first() else visible.last()
	if (over.id == draggedId) return null
	val overRow = byId[over.id] ?: return null

	val parent = overRow.entry.parent
	// A row cannot land inside its own subtree: that makes it its own ancestor, which every walk
	// over the tree then has to survive rather than prevent.
	if (parent != null && isDescendantOf(parent, draggedId, byId)) return null
	// Siblings in rank order, the dragged row excluded - it is being repositioned among them.
	val siblings = rows
		.filter { it.entry.parent == parent && it.entry.id != draggedId && it.entry.trashedAt == null }
		.sortedBy { it.entry.rank }
	val insertAbove = pointerY < over.center
	val overIndex = siblings.indexOfFirst { it.entry.id == over.id }
	if (overIndex < 0) return null

	val (before, after) = if (insertAbove) {
		siblings.getOrNull(overIndex - 1)?.entry?.rank to siblings[overIndex].entry.rank
	} else {
		siblings[overIndex].entry.rank to siblings.getOrNull(overIndex + 1)?.entry?.rank
	}
	// Dropping exactly where it already sits changes nothing.
	if (dragged.entry.parent == parent && before == dragged.entry.rank) return null
	return BoardDrop(draggedId, parent, BoardRank.between(before, after))
}

/** Whether `candidate` sits at or below `ancestor` in the tree. Walks with a visited set so bad
 * data (a parent cycle across a Gateway union) terminates instead of hanging. */
private fun isDescendantOf(candidate: String, ancestor: String, byId: Map<String, BoardRow>): Boolean {
	val seen = mutableSetOf<String>()
	var cur: String? = candidate
	while (cur != null && seen.add(cur)) {
		if (cur == ancestor) return true
		cur = byId[cur]?.entry?.parent
	}
	return false
}

/** How far each row shifts while a drag is in flight: rows between the dragged row's origin and
 * the pointer move by the dragged row's own height, so the gap opens where it will land. Variable
 * row heights are handled by shifting by the DRAGGED row's span, the one thing that is constant. */
fun boardRowShift(draggedId: String, pointerY: Int, visible: List<RowSpan>): Map<String, Int> {
	val dragged = visible.firstOrNull { it.id == draggedId } ?: return emptyMap()
	val out = mutableMapOf<String, Int>()
	for (row in visible) {
		if (row.id == draggedId) continue
		val movingUp = pointerY < dragged.center
		val inRange = if (movingUp) {
			row.center in pointerY until dragged.center
		} else {
			row.center in (dragged.center + 1)..pointerY
		}
		if (inRange) out[row.id] = if (movingUp) dragged.height else -dragged.height
	}
	return out
}
