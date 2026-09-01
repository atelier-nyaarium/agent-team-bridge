package com.atelier_nyaarium.switchboard.board

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.oneLine
import kotlin.math.roundToInt

/** What the strip puts between its edge and a row's start, which the landing line matches. */
private val STRIP_INSET = 14.dp

/**
 * The in-thread board strip, pinned under the top bar: this session's tree.
 *
 * Tap a row to open its editor, long press to move it and its subtree. Capturing a new entry needs
 * the backlog beside it and stays on the Backlog tab.
 */
@Composable
fun BoardStrip(
	group: BoardGroup?,
	liveLine: BoardLiveLine?,
	revision: Long = 0L,
	heightDp: Int = AppStateStore.BOARD_STRIP_DEFAULT_DP,
	onHeightDp: (Int) -> Unit = {},
	onOpenEntry: (BoardRow) -> Unit = {},
	onMove: (BoardRow, BoardDrop) -> Unit = { _, _ -> },
) {
	if (group == null || group.rows.isEmpty()) return
	var expanded by rememberSaveable { mutableStateOf(true) }

	// The gesture reads the stored height once at drag start, so a slow resize is not fighting its own
	// writes frame by frame.
	var resizeBase by remember { mutableIntStateOf(heightDp) }
	var resizeAcc by remember { mutableFloatStateOf(0f) }
	val latestHeight by rememberUpdatedState(heightDp)

	val listState = rememberLazyListState()
	val drag = rememberBoardDragController(listState, revision, group.rows, onMove)
	// Comfort, not correctness: auto-scroll is what actually reaches a long board, and this just puts
	// more of it under the finger while a drag is running.
	val bodyHeight by animateDpAsState(
		if (drag.ui.dragging) AppStateStore.BOARD_STRIP_MAX_DP.dp else heightDp.dp,
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
					// Not "Backlog": that tab is what nobody has claimed, and this is what this session has.
					Text("Tasks", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
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
				Box {
					LazyColumn(
						state = listState,
						// A cap, not a fixed height: a short board should not reserve empty space above the
						// transcript just because the grabber was dragged low once.
						modifier = Modifier
							.heightIn(max = bodyHeight)
							.padding(bottom = 8.dp)
							.boardDragInput(drag),
						// The finger is placing a row, not scrolling. The list still moves, but under the
						// drag's own control.
						userScrollEnabled = !drag.ui.dragging,
					) {
						boardRowItems(group.rows, drag, BoardRowPresentation.Strip, onOpen = onOpenEntry)
					}
					BoardDropOverlay(drag, STRIP_INSET)
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
