package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

////////////////////////////////
//  Composables

// The queue list. Opened by the bubble and by the transport notification's body, so it is reachable
// whether or not the overlay permission was ever granted.
// NOT while locked. Every other overlay down here is reached by an in-app gesture, which already
// implies an unlocked session; this one arrives by INTENT from the notification or the bubble, so
// without the guard a tap on a locked phone would put queued message titles and working transport
// controls on top of the lock screen.
@Composable
internal fun QueueOverlay(
	repo: ChatRepository,
	openQueueRequest: MutableState<Boolean>,
	locked: Boolean,
	revealAtState: MutableState<Pair<String, Long>?>,
	openTeamRequest: MutableState<String?>,
) {
	var revealAt by revealAtState
	if (openQueueRequest.value && !locked) {
		QueueSheetHost(
			repo = repo,
			onDismiss = { openQueueRequest.value = false },
			onJump = { entry ->
				// Through the same request the notification tap uses, so the jump inherits its whole
				// open gesture - dismissing masking surfaces, selecting the tab, re-snapping - rather
				// than re-implementing a partial copy of it.
				revealAt = entry.team to entry.at
				openTeamRequest.value = entry.team
				openQueueRequest.value = false
			},
		)
	}
}

// Composed after the screens so it overlays them and its BackHandler wins.
@Composable
internal fun AttachmentViewerOverlay(viewerState: MutableState<OpenAttachment?>, rendererPool: ThreadRendererPool) {
	var viewer by viewerState
	viewer?.let { att ->
		AttachmentViewer(
			att = att,
			onOpenWith = {
				rendererPool.openWith(att.relPath)
				viewer = null
			},
			onDismiss = { viewer = null },
		)
	}
}
