package com.atelier_nyaarium.switchboard.plugins.designer

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.plugins.ThreadDockScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

////////////////////////////////
//  Composables

/**
 * The Designer dock: a fixed bar above the composer listing the latest of each canvas, expanding
 * into a gallery, each opening full-screen with a per-card action set. It ALSO hosts the viewer for
 * a card-marked attachment chip tapped in the chat body (which opens that exact file), so the dock
 * composes even when the gallery is empty. Version history is intentionally absent - an older
 * revision is an earlier chat message, reached by tapping its chip.
 */
@Composable
fun DesignerDock(scope: ThreadDockScope) {
	val team = scope.team
	val context = LocalContext.current
	val repo = remember { Repo.get(context) }
	val filesDir = context.filesDir

	// Render straight from the additive store: the inbound pipeline ingests each design-card message
	// exactly once from its wire fields, so the dock never re-scans the thread and never reads a file
	// to know a card exists. Bytes are resolved HERE, at render, from the live row - a pure function
	// of current state re-evaluated on every recomposition, so a card whose bytes land 3ms or 3 days
	// after its message reaches the same rendered end state with no moment to miss.
	val stored by androidx.compose.runtime.key(team) { DesignStore.cards(team).collectAsState() }
	val appState by repo.state.collectAsState()
	val failedFetches by repo.failedAttachmentFetches.collectAsState()
	val cards = remember(stored, appState.threads[team], failedFetches) {
		val rows = appState.threads[team].orEmpty()
		stored.map { c ->
			val rel = c.rel ?: resolveCardRel(rows, c)
			c.toCard(rel, fetchFailed = rel == null && c.blobId != null && c.blobId in failedFetches)
		}
	}

	// State keyed by team: the dock is one composable instance reused across tab/session switches
	// (the scope changes, the instance does not), so unkeyed state would carry an open sheet or
	// canvas from one conversation into the next.
	var expanded by remember(team) { mutableStateOf(false) }
	var viewer by remember(team) { mutableStateOf<ViewerTarget?>(null) }

	// Chip-tap hand-off: a tap on a card-marked attachment in the chat body opens THAT EXACT file
	// here. Events (replay 0) never replay on re-entry; the exact card is built off the tapped rel,
	// independent of the gallery, so an old revision or a dock-deleted canvas still opens.
	var pendingOpenRel by remember(team) { mutableStateOf<String?>(null) }
	androidx.compose.runtime.LaunchedEffect(team) {
		DesignerOpenBus.events.collect { req -> if (req.team == team) pendingOpenRel = req.rel }
	}
	androidx.compose.runtime.LaunchedEffect(pendingOpenRel) {
		val rel = pendingOpenRel ?: return@LaunchedEffect
		// Read BEFORE clearing the key: nulling pendingOpenRel re-keys this effect, and doing that
		// ahead of the suspend would let a recomposition cancel the in-flight read and silently drop
		// the tap. If a newer tap changed pendingOpenRel while we were reading, this read is superseded:
		// leave the key set (its own effect processes the newer tap) and DO NOT open our now-stale card,
		// or a slower first read could clobber the newer tap's viewer. Latest tap wins.
		val card = withContext(Dispatchers.IO) { buildCardForRel(filesDir, rel) }
		if (pendingOpenRel != rel) return@LaunchedEffect
		pendingOpenRel = null
		if (card != null) {
			expanded = false
			viewer = ViewerTarget.Chip(card)
		}
	}

	// When the gallery empties (e.g. the last card deleted), close the sheet and any open gallery
	// viewer. Done in an effect, not during composition, to avoid a compositional state write. A
	// Chip viewer stays open - it shows a standalone tapped file, independent of the gallery.
	androidx.compose.runtime.LaunchedEffect(cards) {
		if (cards.isEmpty()) {
			expanded = false
			if (viewer is ViewerTarget.Gallery) viewer = null
		}
	}

	if (cards.isNotEmpty()) {
		// Keeps the offscreen thumbnail WebView window-attached while any thumb slot is on screen.
		DesignerThumbHost()
		DockBar(cards, filesDir) { expanded = true }
	}
	if (expanded) {
		CanvasSheet(
			cards = cards,
			filesDir = filesDir,
			onOpen = {
				viewer = ViewerTarget.Gallery(it)
				expanded = false
			},
			onAction = { card, action -> runAction(context, scope, filesDir, card, action) {} },
			onRetry = { card -> card.blobId?.let { repo.retryAttachmentFetch(it) } },
			onDismiss = { expanded = false },
		)
	}
	viewer?.let { target ->
		// Gallery renders from LIVE cards (so a re-push reflects); chip renders its standalone card.
		val items = when (target) {
			is ViewerTarget.Gallery -> cards
			is ViewerTarget.Chip -> listOf(target.card)
		}
		val index = when (target) {
			is ViewerTarget.Gallery -> target.index
			is ViewerTarget.Chip -> 0
		}
		if (items.isNotEmpty()) {
			CanvasViewer(
				items = items,
				index = index.coerceIn(0, items.lastIndex),
				filesDir = filesDir,
				// Delete manages the dock GALLERY (remove this canvas). A Chip viewer shows a specific
				// historical file, not a gallery entry, so it omits Delete - deleting from there would
				// confusingly remove the CURRENT gallery card, not the file on screen.
				allowDelete = target is ViewerTarget.Gallery,
				onIndex = { viewer = ViewerTarget.Gallery(it) },
				onAction = { card, action ->
					runAction(context, scope, filesDir, card, action) {
						if (action == CardAction.DELETE) viewer = null
					}
				},
				onRetry = { card -> card.blobId?.let { repo.retryAttachmentFetch(it) } },
				onClose = { viewer = null },
			)
		}
	}
}
