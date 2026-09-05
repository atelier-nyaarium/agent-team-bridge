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

val BOARD_INDENT = 16.dp

enum class BoardRowPresentation { Strip, Board }

private val BoardRowPresentation.inset: Dp
	get() = if (this == BoardRowPresentation.Strip) 14.dp else 0.dp

@Composable
fun BoardEntryRow(
	row: BoardRow,
	presentation: BoardRowPresentation,
	carried: Boolean,
	onClick: () -> Unit,
) {
	val entry = row.entry
	val strip = presentation == BoardRowPresentation.Strip
	val finished = entry.state == "done" || entry.state == "cancelled"
	Row(
		Modifier
			.fillMaxWidth()
			.then(if (carried) Modifier.background(MaterialTheme.colorScheme.secondaryContainer) else Modifier)
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

// Draw drop feedback above the list so scrolled rows cannot hide it.
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
