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

// Depth travel exceeds one indent to prevent vertical drift from re-parenting.
private val DEPTH_STEP = 56.dp

// The edge band is capped to one quarter of the viewport.
private val AUTO_SCROLL_BAND = 72.dp

private val AUTO_SCROLL_MAX = 900.dp

enum class BoardListContentType { Row, Chrome }

/** Keys must survive Android Bundles. */
fun boardRowKey(entryId: String): String = "$ROW_KEY_PREFIX$entryId"

private const val ROW_KEY_PREFIX = "boardrow:"

private fun entryIdOfKey(key: Any?): String? =
	(key as? String)?.takeIf { it.startsWith(ROW_KEY_PREFIX) }?.removePrefix(ROW_KEY_PREFIX)

// Spans come from currently rendered items, not disposed rows.
internal fun visibleBoardSpans(state: LazyListState, allowed: Set<String>): List<RowSpan> =
	state.layoutInfo.visibleItemsInfo
		.mapNotNull { item ->
			val id = entryIdOfKey(item.key) ?: return@mapNotNull null
			if (id !in allowed) return@mapNotNull null
			RowSpan(id, item.offset, item.size)
		}
		.sortedBy { it.top }

@Immutable
data class BoardDropIndicator(val yPx: Float, val depth: Int)

@Immutable
data class BoardDragUiState(
	val draggedId: String? = null,
	val carried: Set<String> = emptySet(),
	val indicator: BoardDropIndicator? = null,
) {
	val dragging: Boolean get() = draggedId != null
}

private class ActiveDrag(
	val epoch: Long,
	val row: BoardRow,
	val rows: List<BoardRow>,
	val carried: Set<String>,
) {
	var pointerY: Float = 0f

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
		// Re-parenting resolves only among rows on the dragged row's Gateway.
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
		// A board revision change invalidates the snapshotted drop rank.
		if (drag.epoch != epoch) return
		onDrop(drag.row, drop)
	}

	fun cancel() = clear()

	private fun clear() {
		autoScroll?.cancel()
		autoScroll = null
		active = null
		pending = null
		if (ui.dragging) ui = BoardDragUiState()
	}

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
		ui = ui.copy(
			indicator = if (drop != null && boundary != null) BoardDropIndicator(boundary.toFloat(), drop.depth) else null,
		)
	}

	private suspend fun driveAutoScroll() {
		var last = withFrameNanos { it }
		while (scope.isActive) {
			val now = withFrameNanos { it }
			val seconds = ((now - last).coerceAtLeast(0) / 1_000_000_000.0).toFloat()
			last = now
			val drag = active ?: return
			// pointerY stays fixed while scrolling; rows move beneath it.
			val info = listState.layoutInfo
			val viewport = (info.viewportEndOffset - info.viewportStartOffset).toFloat()
			if (viewport <= 0f) continue
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
