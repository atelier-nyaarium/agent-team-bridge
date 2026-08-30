package com.atelier_nyaarium.switchboard.board

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.oneLine
import kotlin.math.roundToInt

/** One indent level, shared by the row padding and the drag's pixels-to-levels conversion so a row
 * lands where its indent says it will. */
private val INDENT = 16.dp

/**
 * How far sideways one level costs. Deliberately NOT [INDENT].
 *
 * Tying the gesture to the visual indent meant half an indent, about 8dp, flipped a level, so an
 * ordinary vertical drag re-parented on thumb drift alone. A level should take a movement the owner
 * meant to make.
 */
private val DEPTH_STEP = 56.dp

/**
 * The in-thread board strip, pinned under the top bar: this session's tree.
 *
 * Read-only for the ops that need the backlog beside them (add, assign), interactive for the ones
 * that do not. Tap a mark to set state, tap a label to open the entry, long press to move it.
 */
@Composable
fun BoardStrip(
	group: BoardGroup?,
	liveLine: BoardLiveLine?,
	heightDp: Int = AppStateStore.BOARD_STRIP_DEFAULT_DP,
	onHeightDp: (Int) -> Unit = {},
	onOpenEntry: (BoardRow) -> Unit = {},
	onMove: (BoardRow, BoardDrop) -> Unit = { _, _ -> },
) {
	if (group == null || group.rows.isEmpty()) return
	var expanded by rememberSaveable { mutableStateOf(true) }

	var draggingId by remember { mutableStateOf<String?>(null) }
	var dragY by remember { mutableFloatStateOf(0f) }
	var dragX by remember { mutableFloatStateOf(0f) }
	val spans = remember { mutableStateMapOf<String, RowSpan>() }
	// The gesture reads the stored height once at drag start, so a slow resize is not fighting its own
	// writes frame by frame.
	var resizeBase by remember { mutableIntStateOf(heightDp) }
	var resizeAcc by remember { mutableFloatStateOf(0f) }
	val latestHeight by rememberUpdatedState(heightDp)

	val density = LocalDensity.current
	val indentPx = with(density) { INDENT.toPx() }
	val depthStepPx = with(density) { DEPTH_STEP.toPx() }
	val ordered = remember(spans.size, spans.values.toList()) { spans.values.sortedBy { it.top } }
	val drop = draggingId?.let {
		boardDropTarget(it, dragY.roundToInt(), ordered, group.rows, (dragX / depthStepPx).roundToInt())
	}
	// The dragged row and everything under it travel as one block.
	val carried = draggingId?.let { boardSubtreeIds(it, group.rows) } ?: emptySet()
	// Only the grabber writes the stored height. A drag expands the strip so a row can reach the far
	// end of a long board, and it settles back untouched.
	val bodyHeight by animateDpAsState(
		if (draggingId != null) AppStateStore.BOARD_STRIP_MAX_DP.dp else heightDp.dp,
		label = "stripHeight",
	)

	Surface(tonalElevation = 2.dp) {
		Column(Modifier.fillMaxWidth()) {
			Row(
				Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(horizontal = 14.dp, vertical = 8.dp),
				horizontalArrangement = Arrangement.spacedBy(9.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Icon(
					if (expanded) Icons.Default.ExpandMore else Icons.AutoMirrored.Filled.KeyboardArrowRight,
					contentDescription = if (expanded) "Collapse" else "Expand",
					tint = MaterialTheme.colorScheme.onSurfaceVariant,
					modifier = Modifier.size(18.dp),
				)
				if (expanded || liveLine == null) {
					Text("Task Board", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
				} else {
					StateMark(liveLine.state)
					Text(
						oneLine(liveLine.title).orEmpty(),
						style = MaterialTheme.typography.bodySmall,
						maxLines = 1,
						overflow = TextOverflow.Ellipsis,
						modifier = Modifier.weight(1f),
					)
				}
				liveLine?.let {
					Text(
						"${it.finished}/${it.total}",
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			}
			if (expanded) {
				Column(
					Modifier
						// A cap, not a fixed height: a short board should not reserve empty space above the
						// transcript just because the grabber was dragged low once.
						.heightIn(max = bodyHeight)
						.verticalScroll(rememberScrollState(), enabled = draggingId == null)
						.padding(bottom = 8.dp),
				) {
					// Nothing moves during a drag, neither the carried rows nor the ones it passes. Moving the
					// row under the finger made it overlap its neighbours, since the list does not open a gap
					// for it; the insertion line is the feedback instead, and it can show depth too.
					for (row in group.rows) {
						val inBlock = row.entry.id in carried
						StripRow(
							row = row,
							dragging = inBlock,
							anyDragging = draggingId != null,
							depth = row.depth,
							insertionDepth = if (drop != null && drop.afterId == row.entry.id) drop.depth else null,
							onSpan = { spans[row.entry.id] = it },
							onOpen = { onOpenEntry(row) },
							onDragStart = {
								draggingId = row.entry.id
								dragY = (spans[row.entry.id]?.center ?: 0).toFloat()
								dragX = 0f
							},
							onDrag = { dx, dy -> dragX += dx; dragY += dy },
							onDragEnd = { landed -> draggingId = null; landed?.let { onMove(row, it) } },
							drop = drop,
						)
					}
				}
				// Grabber. Sets the resting height, and is the only thing that stores one.
				Box(
					Modifier
						.fillMaxWidth()
						.height(16.dp)
						.pointerInput(Unit) {
							detectVerticalDragGestures(
								onDragStart = { resizeBase = latestHeight; resizeAcc = 0f },
								onVerticalDrag = { change, delta ->
									change.consume()
									// Accumulated in dp across the gesture, so a slow drag is not truncated
									// away one sub-pixel at a time.
									resizeAcc += delta.toDp().value
									onHeightDp(resizeBase + resizeAcc.roundToInt())
								},
							)
						},
					contentAlignment = Alignment.Center,
				) {
					Box(
						Modifier
							.width(32.dp)
							.height(3.dp)
							.clip(RoundedCornerShape(2.dp))
							.background(MaterialTheme.colorScheme.outline),
					)
				}
			}
		}
	}
}

@Composable
private fun StripRow(
	row: BoardRow,
	dragging: Boolean,
	anyDragging: Boolean,
	depth: Int,
	/** Draw the landing indicator under this row, indented to that depth. Null for no indicator. */
	insertionDepth: Int?,
	onSpan: (RowSpan) -> Unit,
	onOpen: () -> Unit,
	onDragStart: () -> Unit,
	onDrag: (Float, Float) -> Unit,
	onDragEnd: (BoardDrop?) -> Unit,
	drop: BoardDrop?,
) {
	val entry = row.entry
	// The drop is recomputed every frame, so the gesture must read the latest rather than the one
	// captured when its pointerInput was installed.
	val latestDrop by rememberUpdatedState(drop)
	Column {
	Row(
		Modifier
			.fillMaxWidth()
			// Marks what is being carried. No elevation: it has not left the list.
			.then(if (dragging) Modifier.background(MaterialTheme.colorScheme.secondaryContainer) else Modifier)
			// Only while nothing is in flight. Every row carries a drag offset once one starts, so
			// recording then would feed each row's own displacement back in as its resting position.
			.onGloballyPositioned {
				if (!anyDragging) onSpan(RowSpan(entry.id, it.positionInParent().y.roundToInt(), it.size.height))
			}
			.pointerInput(entry.id) {
				detectDragGesturesAfterLongPress(
					onDragStart = { onDragStart() },
					onDrag = { change, amount -> change.consume(); onDrag(amount.x, amount.y) },
					onDragEnd = { onDragEnd(latestDrop) },
					onDragCancel = { onDragEnd(null) },
				)
			}
			// The whole row, not the label alone: with no second target on the row there is no reason to
			// make the owner hit the text.
			.clickable(onClick = onOpen)
			.padding(start = (14 + depth * 16).dp, end = 14.dp, top = 3.dp, bottom = 3.dp),
		horizontalArrangement = Arrangement.spacedBy(9.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		StateMark(entry.state)
		Text(
			// Collapsed because this row cannot show a second line. The board tab renders the same title
			// at maxLines = 2 and leaves it alone, since there it has somewhere to go.
			oneLine(entry.title).orEmpty(),
			style = MaterialTheme.typography.bodySmall,
			textDecoration = if (entry.state == "cancelled") TextDecoration.LineThrough else null,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f),
		)
	}
	// Where it lands, drawn at the target depth. This is the only feedback for the sideways axis, so
	// it is indented rather than a plain full-width rule.
	insertionDepth?.let { d ->
		Box(
			Modifier
				.padding(start = (14 + d * 16).dp, end = 14.dp)
				.fillMaxWidth()
				.height(2.dp)
				.clip(RoundedCornerShape(1.dp))
				.background(MaterialTheme.colorScheme.primary),
		)
	}
	}
}

private fun stateLabel(state: String): String =
	if (state == "in_progress") "In progress" else state.replaceFirstChar { it.uppercase() }
