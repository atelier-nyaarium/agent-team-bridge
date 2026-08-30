package com.atelier_nyaarium.switchboard.board

/** One visible row's vertical extent, as LazyListState.layoutInfo reports it. Only VISIBLE rows
 * exist: a LazyColumn disposes the rest, which is why the x-axis tab math (which needs every slot's
 * bounds) cannot be ported here. */
data class RowSpan(val id: String, val top: Int, val height: Int) {
	val center: Int get() = top + height / 2
}

/** Where a drag would land: the new parent (null = top level), the rank to mint between the resolved
 * siblings, and the depth it lands at, which the caller draws its insertion line at. Null when the
 * drop is a no-op or the target cannot be resolved. */
data class BoardDrop(
	val id: String,
	val parent: String?,
	val rank: String,
	val depth: Int,
	/** The visible row the insertion sits directly below, or null for the very top. The caller draws
	 * its indicator from this rather than re-deriving the slot from pointer coordinates. */
	val afterId: String?,
)

/**
 * The drop target for a row dragged to `pointerY`, `depthDelta` levels sideways.
 *
 * Resolved against the FLATTENED rows rather than a flat index: a visible neighbour may sit at a
 * different depth, so "between my two visible neighbours" is not the same as "between two siblings".
 *
 * Depth is CHOSEN, not inherited from whatever row the pointer happens to be over. The caller turns
 * horizontal drag into whole levels; this clamps them to what the slot allows and resolves the
 * parent from the row above. Pixels stay a caller concern, tree legality stays here.
 */
fun boardDropTarget(
	draggedId: String,
	pointerY: Int,
	visible: List<RowSpan>,
	rows: List<BoardRow>,
	depthDelta: Int = 0,
): BoardDrop? {
	if (visible.isEmpty()) return null
	val byId = rows.associateBy { it.entry.id }
	val dragged = byId[draggedId] ?: return null

	// A row carries its subtree, so neither it nor a descendant is a legal neighbour. Landing inside
	// itself would make it its own ancestor, which every later walk would have to survive.
	val moving = rows.filter { isDescendantOf(it.entry.id, draggedId, byId) }.mapTo(mutableSetOf()) { it.entry.id }
	val candidates = rows.filter { it.entry.id !in moving && it.entry.trashedAt == null }
	if (candidates.isEmpty()) return null

	// The row whose span contains the pointer, else the nearest edge row.
	val over = visible.firstOrNull { pointerY >= it.top && pointerY < it.top + it.height }
		?: if (pointerY < visible.first().top) visible.first() else visible.last()
	if (over.id in moving) return null
	val overIndex = candidates.indexOfFirst { it.entry.id == over.id }
	if (overIndex < 0) return null
	val insertAt = if (pointerY < over.center) overIndex else overIndex + 1

	val above = candidates.getOrNull(insertAt - 1)
	val below = candidates.getOrNull(insertAt)
	// No deeper than one below the row above, and no shallower than the row below, which would
	// otherwise be left without its parent.
	val maxDepth = (above?.depth ?: -1) + 1
	val minDepth = (below?.depth ?: 0).coerceAtMost(maxDepth)
	val depth = (dragged.depth + depthDelta).coerceIn(minDepth, maxDepth)

	var ancestor = above
	while (ancestor != null && ancestor.depth > depth - 1) ancestor = byId[ancestor.entry.parent]
	val parent = if (depth == 0) null else ancestor?.entry?.id ?: return null

	val position = candidates.withIndex().associate { (i, r) -> r.entry.id to i }
	val siblings = candidates.filter { it.entry.parent == parent }
	val prev = siblings.filter { (position[it.entry.id] ?: -1) < insertAt }.maxByOrNull { position[it.entry.id] ?: -1 }
	val next = siblings
		.filter { (position[it.entry.id] ?: Int.MAX_VALUE) >= insertAt }
		.minByOrNull { position[it.entry.id] ?: Int.MAX_VALUE }

	// Already sitting between these two, at this depth.
	if (parent == dragged.entry.parent &&
		(prev == null || dragged.entry.rank > prev.entry.rank) &&
		(next == null || dragged.entry.rank < next.entry.rank)
	) {
		return null
	}
	return BoardDrop(
		draggedId,
		parent,
		BoardRank.between(prev?.entry?.rank, next?.entry?.rank),
		depth,
		above?.entry?.id,
	)
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

/**
 * How far each row shifts while a drag is in flight: rows between the dragged subtree's origin and
 * the pointer move by the whole subtree's height, so the gap that opens is the size of what is
 * actually being carried.
 *
 * `moving` is the dragged row and its descendants. They travel together and are never shifted
 * against each other, so the caller offsets them as one block.
 */
fun boardRowShift(
	draggedId: String,
	pointerY: Int,
	visible: List<RowSpan>,
	moving: Set<String> = setOf(draggedId),
): Map<String, Int> {
	val dragged = visible.firstOrNull { it.id == draggedId } ?: return emptyMap()
	val carried = visible.filter { it.id in moving }
	val blockHeight = carried.sumOf { it.height }.takeIf { it > 0 } ?: dragged.height
	val out = mutableMapOf<String, Int>()
	for (row in visible) {
		if (row.id in moving) continue
		val movingUp = pointerY < dragged.center
		val inRange = if (movingUp) {
			row.center in pointerY until dragged.center
		} else {
			row.center in (dragged.center + 1)..pointerY
		}
		if (inRange) out[row.id] = if (movingUp) blockHeight else -blockHeight
	}
	return out
}

/** The dragged row plus everything under it, which a move carries along. */
fun boardSubtreeIds(draggedId: String, rows: List<BoardRow>): Set<String> {
	val byId = rows.associateBy { it.entry.id }
	return rows.filter { isDescendantOf(it.entry.id, draggedId, byId) }.mapTo(mutableSetOf()) { it.entry.id }
}
