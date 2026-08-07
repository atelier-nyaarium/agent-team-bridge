package com.atelier_nyaarium.switchboard.board

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.oneLine

/**
 * The in-thread board strip, pinned under the top bar: this session's tree, reading only - no
 * drag, no assign, no trash, since those need the backlog beside them and it lives on the
 * board tab. Opens EXPANDED, since the strip exists to show the session's work and hiding it by
 * default costs a tap for nothing; the height is capped so a busy session cannot bury the transcript.
 */
@Composable
fun BoardStrip(group: BoardGroup?, liveLine: BoardLiveLine?) {
	if (group == null || (group.rows.isEmpty() && group.gatheredRows.isEmpty())) return
	var expanded by rememberSaveable { mutableStateOf(true) }

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
				Column(Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
					for (row in group.rows) StripRow(row)
					// Finished rows render like any other, struck through by their own state. A counted
					// summary line said less than the rows themselves and cost a line of its own.
					for (row in group.gatheredRows) StripRow(row)
				}
			}
		}
	}
}

@Composable
private fun StripRow(row: BoardRow) {
	val entry = row.entry
	Row(
		Modifier.fillMaxWidth().padding(start = (14 + row.depth * 16).dp, end = 14.dp, top = 3.dp, bottom = 3.dp),
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
		if (row.foldedCount > 0) {
			Text(
				"${row.foldedCount}",
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}
