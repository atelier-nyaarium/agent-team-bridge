package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** One row of the queue as the sheet needs it. Durations are null until the audio exists. */
data class QueueRow(
	val entry: QueueEntry,
	val sessionLabel: String,
	val title: String,
	val durationMs: Long?,
	val isCurrent: Boolean,
)

/**
 * The queue, with a transport and one seek bar.
 *
 * ONE bar, over the current entry's BODY only. Markers are not on it: a chime and a session name are
 * boundaries, not content, and a bar that swept through them would invite seeking into audio that has
 * no position worth landing on.
 *
 * Takes everything as parameters and owns no playback state, so it cannot disagree with the thread row
 * or the lockscreen about what is happening.
 */
@Composable
fun QueueSheet(
	rows: List<QueueRow>,
	failed: List<QueueRow>,
	paused: Boolean,
	positionMs: Long?,
	durationMs: Long?,
	onPlayPause: () -> Unit,
	onSkip: () -> Unit,
	onSeek: (Long) -> Unit,
	onTrash: (QueueEntry) -> Unit,
	onJump: (QueueEntry) -> Unit,
	onDismissFailure: (QueueEntry) -> Unit,
) {
	// An empty queue has nothing to pause or skip. Left enabled, the row offered a Pause that did
	// nothing and a Skip with nothing to skip, which reads as a broken control rather than an idle one.
	val running = rows.isNotEmpty()
	Column(Modifier.fillMaxWidth().padding(16.dp)) {
		Row(verticalAlignment = Alignment.CenterVertically) {
			IconButton(onClick = onPlayPause, enabled = running) {
				Icon(
					if (paused) Icons.Filled.PlayArrow else Icons.Filled.Pause,
					contentDescription = if (paused) "Resume" else "Pause",
				)
			}
			IconButton(onClick = onSkip, enabled = running) {
				Icon(Icons.Filled.SkipNext, contentDescription = "Skip")
			}
			Text(clock(positionMs) + " / " + clock(durationMs), style = MaterialTheme.typography.labelMedium)
		}
		// Disabled rather than hidden while the length is unknown: a bar that appears once synthesis
		// finishes makes the row jump under the thumb.
		Slider(
			value = if (durationMs != null && durationMs > 0 && positionMs != null) {
				positionMs.toFloat() / durationMs.toFloat()
			} else {
				0f
			},
			onValueChange = { fraction -> durationMs?.let { onSeek((fraction * it).toLong()) } },
			enabled = durationMs != null && durationMs > 0,
		)
		Spacer(Modifier.height(8.dp))
		// One list, so the failures cannot scroll independently of the queue above them. There is
		// deliberately no clear-all: per-entry trash plus swipe-to-skip covers it, and nothing here is
		// worth an action that discards several messages on one tap.
		LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
			items(rows, key = { "q|" + keyOf(it.entry) }) { row ->
				QueueTile(row, onTrash = { onTrash(row.entry) }, onJump = { onJump(row.entry) })
			}
			if (failed.isNotEmpty()) {
				item(key = "failed-header") {
					Text(
						"Gave up",
						style = MaterialTheme.typography.titleSmall,
						modifier = Modifier.padding(top = 12.dp),
					)
				}
				items(failed, key = { "f|" + keyOf(it.entry) }) { row ->
					// Dismissing is "seen", not "resolved". The message was never spoken and nothing here
					// pretends otherwise - the jump is what actually gets the user to it.
					QueueTile(row, onTrash = { onDismissFailure(row.entry) }, onJump = { onJump(row.entry) })
				}
			}
		}
	}
}

private fun keyOf(entry: QueueEntry): String = "${entry.team}|${entry.at}|${entry.tier}"

@Composable
private fun QueueTile(row: QueueRow, onTrash: () -> Unit, onJump: () -> Unit) {
	Surface(
		onClick = onJump,
		tonalElevation = if (row.isCurrent) 4.dp else 0.dp,
		modifier = Modifier.fillMaxWidth(),
	) {
		Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
			Column(Modifier.fillMaxWidth(0.85f)) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Text(row.sessionLabel, style = MaterialTheme.typography.titleSmall)
					Spacer(Modifier.size(8.dp))
					// A spinner until the length is known, because "no duration" and "zero seconds"
					// would otherwise look the same.
					if (row.durationMs == null) {
						CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
					} else {
						Text(clock(row.durationMs), style = MaterialTheme.typography.labelSmall)
					}
				}
				Text(row.title, style = MaterialTheme.typography.bodySmall, maxLines = 2)
			}
			IconButton(onClick = onTrash) {
				Icon(Icons.Filled.Delete, contentDescription = "Remove from queue")
			}
		}
	}
}

private fun clock(ms: Long?): String {
	if (ms == null) return "--:--"
	val total = ms / 1000
	return "%d:%02d".format(total / 60, total % 60)
}
