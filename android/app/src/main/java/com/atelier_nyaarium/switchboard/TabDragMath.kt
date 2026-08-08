package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Tab drag-reorder geometry
//
//  Pure math behind ReorderableTabRow.kt's ReorderableTabRow. All positions are untranslated layout slots
//  (what onGloballyPositioned reports; graphicsLayer translation never moves a layout slot), so the
//  visual shifts and ghost these functions drive can never feed back into their own inputs. An
//  insertion index is a position in the list WITHOUT the dragged item (remove-then-insert
//  convention), matching tabCommitOrder.

/** One tab's untranslated layout slot within the row, in pixels. */
data class TabSlot(val x: Float, val y: Float, val width: Float, val height: Float)

/** Where the dragged tab would land: the count of OTHER tabs whose slot center sits left of the
 * ghost's center. Slot centers never move during a drag, so the mapping is stable and monotonic
 * as the ghost travels. */
fun tabInsertionIndex(slots: List<TabSlot>, draggedIndex: Int, ghostCenterX: Float): Int {
	var k = 0
	slots.forEachIndexed { i, s ->
		if (i != draggedIndex && s.x + s.width / 2f < ghostCenterX) k++
	}
	return k
}

/** How far tab [index] slides to open the landing gap: one dragged-tab span toward the vacated
 * slot for tabs sitting between the origin and the target, zero for everything else. */
fun tabShift(index: Int, draggedIndex: Int, insertionIndex: Int, draggedSpan: Float): Float {
	if (index == draggedIndex) return 0f
	val j = if (index < draggedIndex) index else index - 1
	return when {
		index < draggedIndex && j >= insertionIndex -> draggedSpan
		index > draggedIndex && j < insertionIndex -> -draggedSpan
		else -> 0f
	}
}

/** Left edge of the open landing gap, in slot coordinates: the row start plus the span of every
 * tab that ends up before the gap. */
fun tabGapLeftEdge(slots: List<TabSlot>, draggedIndex: Int, insertionIndex: Int, gapPx: Float): Float {
	var x = slots.first().x
	var j = 0
	for ((i, s) in slots.withIndex()) {
		if (i == draggedIndex) continue
		if (j >= insertionIndex) break
		x += s.width + gapPx
		j++
	}
	return x
}

/** The committed order: the dragged item removed and re-inserted at the insertion index. */
fun <T> tabCommitOrder(tabs: List<T>, draggedIndex: Int, insertionIndex: Int): List<T> {
	val next = tabs.toMutableList()
	val item = next.removeAt(draggedIndex)
	next.add(insertionIndex, item)
	return next
}
