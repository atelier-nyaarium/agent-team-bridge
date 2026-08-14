package com.atelier_nyaarium.switchboard

// The docks ThreadScreen stacks above its composer.

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

////////////////////////////////
//  Composables

/** Dock for a pending scheduled send: a plain sibling in ThreadScreen's Column, stacking above the
 * composer like the Designer dock's threadDockSlots. Tapping reopens [ScheduleSendDialog] to retime
 * it (see onEdit's doc at the ThreadScreen call site for why this is time-only); the trailing icon
 * cancels outright. */
@Composable
fun ScheduledSendDock(rec: ScheduledSend, onEdit: () -> Unit, onCancel: () -> Unit, cancelEnabled: Boolean) {
	// NOT remember-cached: a device timezone change while this composable stays mounted must be
	// picked up on the next recomposition, mirroring IdlePushbackManager's own fresh-read-per-call
	// discipline for the identical value (it takes zone as a supplier invoked fresh every decide()).
	val zone = java.time.ZoneId.systemDefault()
	// Recomputed roughly every minute while the thread is open - "live-ish", not truly ticking
	// per-second, mirroring the cross-domain-presence freshness chip's own periodic-ticker pattern.
	var now by remember { mutableStateOf(System.currentTimeMillis()) }
	LaunchedEffect(rec.opId) {
		while (true) {
			delay(60_000)
			now = System.currentTimeMillis()
		}
	}
	Surface(
		modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
		color = MaterialTheme.colorScheme.secondaryContainer,
		shape = MaterialTheme.shapes.medium,
	) {
		Row(
			Modifier.fillMaxWidth().clickable(onClick = hapticClick(onEdit)).padding(12.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			Icon(Icons.Default.Schedule, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
			Column(Modifier.weight(1f)) {
				Text(
					"Sending at ${absoluteTimeText(rec.fireAtMillis, zone)}",
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onSecondaryContainer,
				)
				Text(
					countdownText(rec.fireAtMillis - now),
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSecondaryContainer,
				)
			}
			// Disabled while the composer holds text, purely as UX - cancelling hands this send's own
			// text and files back into the draft (ChatRepository.takeBackIntoDraft), which itself
			// guards against overwriting whatever is being typed regardless of this flag. Matches the
			// failed-send row's own Cancel.
			IconButton(onClick = hapticClick(onCancel), enabled = cancelEnabled) {
				Icon(
					Icons.Default.Close,
					contentDescription = "Cancel scheduled send",
					tint = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = if (cancelEnabled) 1f else 0.4f),
				)
			}
		}
	}
}

/** Dock for an armed goal, showing what will be typed. Sibling of [ScheduledSendDock], but never a
 * composer replacement: the message it rides on is already gone. */
@Composable
fun GoalDock(rec: PendingGoal, onCancel: () -> Unit) {
	Surface(
		modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
		// Same container as ScheduledSendDock: same kind of thing, and the error one sits just below.
		color = MaterialTheme.colorScheme.secondaryContainer,
		shape = MaterialTheme.shapes.medium,
	) {
		Row(
			Modifier.fillMaxWidth().padding(12.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			Icon(Icons.Default.Flag, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
			Column(Modifier.weight(1f)) {
				Text(
					"Goal: ${rec.text}",
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onSecondaryContainer,
					maxLines = 2,
					overflow = TextOverflow.Ellipsis,
				)
				Text(
					"Waiting for its terminal",
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSecondaryContainer,
				)
			}
			IconButton(onClick = hapticClick(onCancel)) {
				Icon(
					Icons.Default.Close,
					contentDescription = "Cancel goal",
					tint = MaterialTheme.colorScheme.onSecondaryContainer,
				)
			}
		}
	}
}

/** Usage-limit notice: the session holds an unanswered limit dialog, so nothing sent to it is read
 * until cleared. A plain sibling in ThreadScreen's Column, stacking above the composer like
 * [ScheduledSendDock] and the plugin dock slots.
 *
 * Deliberately has no dismiss: this is a fact about the session, not a message about it, so hiding it
 * would only hide the affordance that resolves it. Clears itself once the dialog is answered and the
 * daemon's next derivation shows the composer back. */
@Composable
fun SessionLimitDock(detail: String?, onResume: () -> Unit, resumeEnabled: Boolean) {
	Surface(
		modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
		color = MaterialTheme.colorScheme.errorContainer,
		shape = MaterialTheme.shapes.medium,
	) {
		Row(
			Modifier.fillMaxWidth().padding(12.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			Icon(Icons.Default.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
			Column(Modifier.weight(1f)) {
				Text(
					"Session Limit hit",
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onErrorContainer,
				)
				if (detail != null) {
					Text(
						detail,
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.onErrorContainer,
					)
				}
			}
			FilledTonalButton(onClick = hapticClick(onResume), enabled = resumeEnabled) {
				Text(if (resumeEnabled) "Resume" else "Resuming...")
			}
		}
	}
}

/** Cold-wake notice: a wake takes minutes with no wire traffic, so this says so without posting into
 * the transcript. Read-only by design - a wake cannot be called off, so there is nothing to tap and
 * no dismiss; clears itself when the send fails or the team answers (ChatState.wakingTeams). */
@Composable
fun WakingNotice(label: String) {
	Surface(
		modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
		color = MaterialTheme.colorScheme.surfaceVariant,
		shape = MaterialTheme.shapes.medium,
	) {
		Row(
			Modifier.fillMaxWidth().padding(12.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			CircularProgressIndicator(
				modifier = Modifier.size(16.dp),
				strokeWidth = 2.dp,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			Text(
				"Waking $label - first boot can take a minute or two.",
				style = MaterialTheme.typography.bodyMedium,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}
