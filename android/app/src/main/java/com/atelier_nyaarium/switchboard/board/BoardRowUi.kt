package com.atelier_nyaarium.switchboard.board

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.oneLine
import kotlin.math.roundToInt

/** One indent level, shared by the row and the landing line so a drop lands where the line said. */
val BOARD_INDENT = 16.dp

/** Which surface is drawing the row. The strip has one line per row above a transcript; the Backlog
 * tab is the whole screen and can afford a second line and the sync decorations. */
enum class BoardRowPresentation { Strip, Board }

private val BoardRowPresentation.inset: Dp
	get() = if (this == BoardRowPresentation.Strip) 14.dp else 0.dp

/**
 * One board entry, on either surface.
 *
 * Carries no gesture of its own. The drag lives on the list, so a row scrolling out of view cannot
 * take the gesture with it.
 */
@Composable
fun BoardEntryRow(
	row: BoardRow,
	presentation: BoardRowPresentation,
	carried: Boolean,
	struggling: Boolean,
	onClick: () -> Unit,
) {
	val entry = row.entry
	val strip = presentation == BoardRowPresentation.Strip
	val finished = entry.state == "done" || entry.state == "cancelled"
	Row(
		Modifier
			.fillMaxWidth()
			// Marks what a drag is carrying. No elevation: it has not left the list.
			.then(if (carried) Modifier.background(MaterialTheme.colorScheme.secondaryContainer) else Modifier)
			// The whole row, not the label: nothing else on the row wants the tap.
			.clickable(onClick = onClick)
			.padding(
				start = presentation.inset + BOARD_INDENT * row.depth,
				end = presentation.inset,
				top = if (strip) 3.dp else 4.dp,
				bottom = if (strip) 3.dp else 4.dp,
			),
		horizontalArrangement = Arrangement.spacedBy(9.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		StateMark(entry.state)
		Text(
			// Collapsed on the strip, which has no second line to give it.
			if (strip) oneLine(entry.title).orEmpty() else entry.title,
			style = if (strip) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium,
			color = if (finished && !strip) {
				MaterialTheme.colorScheme.onSurfaceVariant
			} else {
				MaterialTheme.colorScheme.onSurface
			},
			textDecoration = if (entry.state == "cancelled") TextDecoration.LineThrough else null,
			maxLines = if (strip) 1 else 2,
			overflow = TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f),
		)
		if (!strip) {
			if (!entry.attachments.isNullOrEmpty()) {
				Text("📎", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
			if (struggling) {
				Text("not synced", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
			}
			entry.trashedAt?.let {
				Text(
					"${daysLeftInTrash(it)}d left",
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
	}
}

/**
 * Where the drag would land, drawn over the list.
 *
 * Over the list rather than under a row, because the row a drop sits against can be scrolled off. An
 * indicator owned by that row would then have nothing to draw it, and a perfectly good drop would
 * show no feedback at all.
 *
 * [rowInset] is whatever the host puts between the list edge and a row's own start.
 */
@Composable
fun BoxScope.BoardDropOverlay(controller: BoardDragController, rowInset: Dp) {
	val indicator = controller.ui.indicator ?: return
	Box(
		Modifier
			.align(Alignment.TopStart)
			.offset { IntOffset(0, indicator.yPx.roundToInt()) }
			.padding(start = rowInset + BOARD_INDENT * indicator.depth, end = rowInset)
			.fillMaxWidth()
			.height(2.dp)
			.clip(RoundedCornerShape(1.dp))
			.background(MaterialTheme.colorScheme.primary),
	)
}
