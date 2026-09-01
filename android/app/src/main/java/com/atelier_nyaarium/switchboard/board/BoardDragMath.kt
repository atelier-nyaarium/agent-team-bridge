package com.atelier_nyaarium.switchboard.board

/** One visible row's vertical extent, as LazyListState.layoutInfo reports it. Only VISIBLE rows
 * exist: a LazyColumn disposes the rest, which is why the x-axis tab math (which needs every slot's
 * bounds) cannot be ported here. */
data class RowSpan(val id: String, val top: Int, val height: Int) {
	val center: Int get() = top + height / 2
}

/** Where a drag would land: the new parent (null = top level), the rank to mint between the resolved
 * siblings, and the depth it lands at. No pixels: where the line is drawn is [boardDropBoundary]. */
data class BoardDrop(
	val id: String,
	val parent: String?,
	val rank: String,
	val depth: Int,
)

/**
 * The visible row an insertion at [pointerY] sits above, or null to sit below the last one.
 *
 * Sole owner of the pointer-to-slot rule, so a drop and the line drawn for it cannot disagree.
 *
 * Chosen by CENTRE rather than by containment. A list with gaps between its items - the board tab
 * spaces them - leaves a pointer in a gap inside no row at all, and the containment form then fell
 * through to whichever row happened to be last.
 */
private fun slotAbove(pointerY: Int, eligible: List<RowSpan>): RowSpan? =
	eligible.firstOrNull { pointerY < it.center }

/** Rows a drop may sit against: everything on screen that is not being carried. */
private fun eligibleSpans(visible: List<RowSpan>, moving: Set<String>): List<RowSpan> =
	visible.filter { it.id !in moving }

/**
 * Where the insertion line goes, in the same coordinates as the spans it was given.
 *
 * Answers from what is VISIBLE, never from the dragged row's logical neighbour, which can be
 * scrolled off. A drop resolved against an offscreen predecessor still has a line, drawn at the edge
 * of the last row that is actually rendered.
 */
fun boardDropBoundary(pointerY: Int, visible: List<RowSpan>, moving: Set<String>): Int? {
	val eligible = eligibleSpans(visible, moving)
	if (eligible.isEmpty()) return null
	val above = slotAbove(pointerY, eligible)
	return above?.top ?: eligible.last().let { it.top + it.height }
}

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

	val eligible = eligibleSpans(visible, moving)
	if (eligible.isEmpty()) return null
	val slot = slotAbove(pointerY, eligible)
	// The row the insertion sits above, or the last one when it sits below everything.
	val anchor = slot ?: eligible.last()
	val anchorIndex = candidates.indexOfFirst { it.entry.id == anchor.id }
	if (anchorIndex < 0) return null
	val insertAt = if (slot != null) anchorIndex else anchorIndex + 1

	val rowAbove = candidates.getOrNull(insertAt - 1)
	val below = candidates.getOrNull(insertAt)
	// No deeper than one below the row above, and no shallower than the row below, which would
	// otherwise be left without its parent.
	val maxDepth = (rowAbove?.depth ?: -1) + 1
	val minDepth = (below?.depth ?: 0).coerceAtMost(maxDepth)
	val depth = (dragged.depth + depthDelta).coerceIn(minDepth, maxDepth)

	var ancestor = rowAbove
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
	return BoardDrop(draggedId, parent, BoardRank.between(prev?.entry?.rank, next?.entry?.rank), depth)
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

/** The dragged row plus everything under it, which a move carries along. */
fun boardSubtreeIds(draggedId: String, rows: List<BoardRow>): Set<String> {
	val byId = rows.associateBy { it.entry.id }
	return rows.filter { isDescendantOf(it.entry.id, draggedId, byId) }.mapTo(mutableSetOf()) { it.entry.id }
}
