package com.atelier_nyaarium.switchboard.board

import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

////////////////////////////////
//  Shared board drag
//
//  Both surfaces that draw board rows drive their drag through here: the thread's strip and the
//  Backlog tab. Each owns its own LazyColumn; this owns the gesture, the geometry and the drop.

/** How far sideways one level costs. Deliberately larger than one indent: at indent-per-level, half
 * an indent of thumb drift re-parented a row during an ordinary vertical drag. */
private val DEPTH_STEP = 56.dp

/** How close to an edge the finger has to get before the list starts moving under it. */
private val AUTO_SCROLL_BAND = 72.dp

/** Top speed at the very edge of the band, per second. */
private val AUTO_SCROLL_MAX = 900.dp

/** What a lazy item is. Only a Row is draggable, and only a Row's key names an entry. */
enum class BoardListContentType { Row, Chrome }

/** Sole minter of a draggable row's lazy key.
 *
 * A String, not a typed class: Android requires a lazy list's keys to survive a `Bundle`, which a
 * class of our own does not. */
fun boardRowKey(entryId: String): String = "$ROW_KEY_PREFIX$entryId"

private const val ROW_KEY_PREFIX = "boardrow:"

/** Sole reader of that key. Anything else in the list - a notice, a header, a trash row - answers
 * null here and so never reaches the drag math. */
private fun entryIdOfKey(key: Any?): String? =
	(key as? String)?.takeIf { it.startsWith(ROW_KEY_PREFIX) }?.removePrefix(ROW_KEY_PREFIX)

/**
 * The rows the list is actually rendering, in the list's own coordinates.
 *
 * Read from the list rather than recorded by each row. A row that scrolls out of a lazy list is
 * disposed, so anything a row recorded for itself outlives the row and can win a hit test it should
 * not be in. This cannot go stale: it is derived, every frame, from what is on screen.
 */
internal fun visibleBoardSpans(state: LazyListState, allowed: Set<String>): List<RowSpan> =
	state.layoutInfo.visibleItemsInfo
		.mapNotNull { item ->
			val id = entryIdOfKey(item.key) ?: return@mapNotNull null
			if (id !in allowed) return@mapNotNull null
			RowSpan(id, item.offset, item.size)
		}
		.sortedBy { it.top }

/** Where the landing line sits and how deep it is drawn. In list coordinates, like the spans. */
@Immutable
data class BoardDropIndicator(val yPx: Float, val depth: Int)

@Immutable
data class BoardDragUiState(
	val draggedId: String? = null,
	/** The dragged row and its descendants, which travel as one block. */
	val carried: Set<String> = emptySet(),
	val indicator: BoardDropIndicator? = null,
) {
	val dragging: Boolean get() = draggedId != null
}

/** One drag in flight. Snapshotted at the start so a board write mid-gesture cannot quietly change
 * what is being resolved against. */
private class ActiveDrag(
	val epoch: Long,
	val row: BoardRow,
	val rows: List<BoardRow>,
	val carried: Set<String>,
) {
	/** In the list's coordinates, the same ones the spans are in. */
	var pointerY: Float = 0f

	/** Physical sideways travel, which is what levels are counted from. */
	var accumulatedX: Float = 0f
}

@Stable
class BoardDragController internal constructor(
	internal val listState: LazyListState,
	private val density: Density,
	private val scope: CoroutineScope,
) {
	internal var rows: List<BoardRow> = emptyList()
	internal var epoch: Long = 0L
	internal var onDrop: (BoardRow, BoardDrop) -> Unit = { _, _ -> }

	var ui by mutableStateOf(BoardDragUiState())
		private set

	private var active: ActiveDrag? = null
	private var pending: BoardDrop? = null
	private var autoScroll: Job? = null

	internal fun begin(at: Offset) {
		val id = rowAt(at.y) ?: return
		val row = rows.firstOrNull { it.entry.id == id } ?: return
		// One Gateway only. A re-parent writes to the dragged row's Gateway, so a drop resolved against
		// another machine's entries would send the write to a board that does not hold them.
		val domain = rows.filter { it.gatewayId == row.gatewayId }
		val drag = ActiveDrag(epoch, row, domain, boardSubtreeIds(id, domain))
		drag.pointerY = at.y
		active = drag
		pending = null
		ui = BoardDragUiState(draggedId = id, carried = drag.carried)
		recompute()
		autoScroll?.cancel()
		autoScroll = scope.launch { driveAutoScroll() }
	}

	internal fun move(amount: Offset) {
		val drag = active ?: return
		drag.pointerY += amount.y
		drag.accumulatedX += amount.x
		recompute()
	}

	internal fun finish() {
		val drag = active
		val drop = pending
		clear()
		if (drag == null || drop == null) return
		// The board may have moved between the last frame and the finger lifting. A rank minted against
		// ranks that have since changed is not the placement the owner was shown.
		if (drag.epoch != epoch) return
		onDrop(drag.row, drop)
	}

	/** Abandon whatever is in flight. The viewport keeps wherever auto-scroll carried it: that was
	 * navigation the owner watched happen, and snapping back is another surprise. */
	fun cancel() = clear()

	private fun clear() {
		autoScroll?.cancel()
		autoScroll = null
		active = null
		pending = null
		if (ui.dragging) ui = BoardDragUiState()
	}

	/** The entry under a point, from what the list says it is rendering. */
	private fun rowAt(y: Float): String? =
		listState.layoutInfo.visibleItemsInfo
			.firstOrNull { y >= it.offset && y < it.offset + it.size }
			?.let { entryIdOfKey(it.key) }

	private fun recompute() {
		val drag = active ?: return
		val allowed = drag.rows.mapTo(mutableSetOf()) { it.entry.id }
		val spans = visibleBoardSpans(listState, allowed)
		val depthStep = with(density) { DEPTH_STEP.toPx() }
		val delta = (drag.accumulatedX / depthStep).roundToInt()
		val at = drag.pointerY.roundToInt()
		val drop = boardDropTarget(drag.row.entry.id, at, spans, drag.rows, delta)
		val boundary = boardDropBoundary(at, spans, drag.carried)
		pending = drop
		// Only where a real drop resolved. A line over a slot that would refuse the drop promises a
		// placement that will not happen.
		ui = ui.copy(
			indicator = if (drop != null && boundary != null) BoardDropIndicator(boundary.toFloat(), drop.depth) else null,
		)
	}

	/**
	 * Move the list while the finger sits near an edge.
	 *
	 * The finger does NOT move in list coordinates while this runs, so `pointerY` is left alone. The
	 * rows move instead, and their new offsets come back from the list on the next frame. Adding the
	 * scrolled distance to the pointer as well would count the movement twice.
	 */
	private suspend fun driveAutoScroll() {
		var last = withFrameNanos { it }
		while (scope.isActive) {
			val now = withFrameNanos { it }
			val seconds = ((now - last).coerceAtLeast(0) / 1_000_000_000.0).toFloat()
			last = now
			val drag = active ?: return
			val info = listState.layoutInfo
			val viewport = (info.viewportEndOffset - info.viewportStartOffset).toFloat()
			if (viewport <= 0f) continue
			// Never more than a quarter of the viewport per edge. The strip can be shrunk to 72dp, where a
			// fixed band covers the whole list and every drag scrolls whatever the finger is doing.
			val band = with(density) { AUTO_SCROLL_BAND.toPx() }.coerceAtMost(viewport / 4f)
			val top = info.viewportStartOffset + band
			val bottom = info.viewportEndOffset - band
			val push = when {
				drag.pointerY < top -> (drag.pointerY - top) / band
				drag.pointerY > bottom -> (drag.pointerY - bottom) / band
				else -> 0f
			}.coerceIn(-1f, 1f)
			if (push != 0f) {
				listState.scrollBy(push * with(density) { AUTO_SCROLL_MAX.toPx() } * seconds)
				recompute()
			}
		}
	}
}

/**
 * The drag's state for one list.
 *
 * [epoch] is the board's own revision. Any change to it abandons a drag in flight: a title edit
 * changes a row's height, and a re-rank changes the very siblings a pending rank was minted between.
 */
@Composable
fun rememberBoardDragController(
	listState: LazyListState,
	epoch: Long,
	rows: List<BoardRow>,
	onDrop: (BoardRow, BoardDrop) -> Unit,
): BoardDragController {
	val density = LocalDensity.current
	val scope = rememberCoroutineScope()
	val controller = remember(listState) { BoardDragController(listState, density, scope) }
	controller.rows = rows
	controller.onDrop = onDrop
	LaunchedEffect(controller, epoch) {
		if (controller.ui.dragging && controller.epoch != epoch) controller.cancel()
		controller.epoch = epoch
	}
	return controller
}

/**
 * The drag gesture, installed on the LIST rather than on each row.
 *
 * A row is disposed when it scrolls out of a lazy list, so a gesture living on the row is torn down
 * by the very auto-scroll it asked for. On the list, the pointer also arrives already in the
 * coordinates the list reports its rows in, leaving no conversion to get wrong.
 */
fun Modifier.boardDragInput(controller: BoardDragController): Modifier =
	pointerInput(controller) {
		detectDragGesturesAfterLongPress(
			onDragStart = { controller.begin(it) },
			onDrag = { change, amount ->
				change.consume()
				controller.move(amount)
			},
			onDragEnd = { controller.finish() },
			onDragCancel = { controller.cancel() },
		)
	}

/** Emit one group's draggable rows. Every key comes from [boardRowKey], which is what makes them
 * findable in the list's geometry and what keeps everything else out of it. */
fun LazyListScope.boardRowItems(
	rows: List<BoardRow>,
	controller: BoardDragController,
	presentation: BoardRowPresentation,
	onOpen: (BoardRow) -> Unit,
) {
	items(
		count = rows.size,
		key = { boardRowKey(rows[it].entry.id) },
		contentType = { BoardListContentType.Row },
	) { index ->
		val row = rows[index]
		BoardEntryRow(
			row = row,
			presentation = presentation,
			carried = row.entry.id in controller.ui.carried,
			onClick = { onOpen(row) },
		)
	}
}
