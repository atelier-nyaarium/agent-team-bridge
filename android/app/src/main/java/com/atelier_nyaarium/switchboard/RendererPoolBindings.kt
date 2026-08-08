package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.atelier_nyaarium.switchboard.plugins.PluginManager
import com.atelier_nyaarium.switchboard.plugins.TappedLink
import kotlinx.coroutines.launch

////////////////////////////////
//  Composables

/** Builds the ThreadRendererPool once and re-applies its callbacks on every recomposition, wiring
 * it to the repo, the plugin framework, and the attachment/link-menu overlay state App exposes. */
@Composable
internal fun rememberBoundRendererPool(
	repo: ChatRepository,
	pluginManager: PluginManager,
	viewerState: MutableState<OpenAttachment?>,
	linkMenuState: MutableState<Pair<String, String>?>,
	linkMenuNoteState: MutableState<String?>,
): ThreadRendererPool {
	val state by repo.state.collectAsState()
	val context = LocalContext.current
	val scope = rememberCoroutineScope()

	// WebView pool lives at App scope (never leaves composition) so each thread's
	// renderer survives Sessions round-trips and tab switches. Pruned to open tabs;
	// destroyed with the Activity.
	val rendererPool = remember { ThreadRendererPool(context.applicationContext) }
	rendererPool.onRetry = { team, id -> repo.command { retrySend(team, id) } }
	rendererPool.onCancel = { team, id -> repo.cancelFailedSend(team, id) }
	// Attribute a message's sender by its human label (a notice's `from` is a canonical address).
	// Reads the live state at render time so a rename reflects without rebuilding the pool.
	rendererPool.resolveFrom = { addr -> repo.state.value.label(addr) }
	// Attribute the local user's own messages by their account display name instead of "you".
	rendererPool.selfLabel = { repo.state.value.displayName }
	// Attachment taps open the in-app viewer; the path is re-validated against the
	// attachments root before any file is touched. The wire mime (what the agent
	// declared) is preferred over extension guessing.
	var viewer by viewerState
	rendererPool.onAttachmentTap = { tapTeam, rel ->
		Attachments.resolve(context.filesDir, rel)?.let { file ->
			// Drafts as well as threads: a picked file belongs to no message, so a threads-only
			// scan leaves the viewer's rows blank for exactly the files a pre-send check is for.
			val wire = state.threads.values.asSequence().flatten()
				.flatMap { it.files.asSequence() }
				.plus(state.drafts.values.asSequence().flatMap { it.files.asSequence() })
				.firstOrNull { it.src?.endsWith("/$rel") == true }
			val mime = wire?.mime?.takeIf { it.isNotEmpty() } ?: mimeForFile(file)
			// A plugin (e.g. the Designer) may claim a tapped attachment and open it in its own
			// viewer; only fall back to the generic attachment viewer when none does. The team is
			// the tapped thread's own (bound per-renderer), not the ambient on-screen team.
			val claimed = pluginManager.host.attachmentOpeners.anyCaught(onError = ::logPluginThrow) {
				it.tryOpen(context, tapTeam, rel, mime, file.name)
			}
			if (!claimed) {
				// Size and mtime come from the WIRE, not from the local copy: the file on disk was
				// written by the fetch, so its own mtime is when it landed here, not the age the
				// sender meant to carry. Absent when the sender never stamped it, and the row hides.
				viewer = OpenAttachment(file, file.name, mime, rel, wire?.size, wire?.modifiedAt)
			}
		}
	}
	// A plugin may decorate its own attachment chips (e.g. the Designer's card title); the first
	// non-null decoration wins, everything else renders the plain chip. Containment matters here:
	// this runs on every sync of every open thread, so a throwing decorator must cost only its own
	// decoration, never the transcript render.
	rendererPool.decorateFile = { team, file ->
		pluginManager.host.attachmentChipDecorators.firstNotNullCaught(onError = ::logPluginThrow) {
			it.decorate(team, file)
		}
	}
	// In-thread Play buttons render only when STTS is provisioned; taps speak the full tier, and the
	// player's now-playing pushes glyph state back. Re-evaluated per recomposition so provisioning
	// in-session lights the buttons for renderers built afterward.
	rendererPool.playEnabled = repo.sttsReady()
	rendererPool.onPlayTap = { team, at ->
		// A tap on an audible message stops it; otherwise it JOINS the queue at FULL rather than
		// starting alongside it. A row that is already queued renders unpressable, so a tap can only
		// ever arrive for one that is idle or playing.
		if (repo.playback.isMessagePlaying(team, at)) {
			repo.playback.stopMessage(team, at)
		} else {
			repo.command { playback.enqueueForPlay(team, at, SttsPlayer.Tier.FULL, announceRun = false) }
		}
	}
	rendererPool.onReadUpTo = { team, id, at -> repo.readUpTo(team, id, at) }
	// Links: a tap on a standard anchor routes through the scheme dispatcher (openLink); the
	// context menu (long-press on a standard anchor, or tap on an unhandled-protocol link)
	// shows the URL with Open enabled only when the dispatcher can actually open it.
	var linkMenu by linkMenuState
	// Set only when a plugin was offered this link and declined it, so the dialog can explain itself.
	var linkMenuNote by linkMenuNoteState
	rendererPool.onLinkTap = { team, url -> openLink(context, team, url) }
	rendererPool.onLinkMenu = { team, url ->
		linkMenuNote = null
		linkMenu = team to url
	}
	// A tapped link whose scheme a plugin claims. The framework resolves the ROW first, so a handler
	// receives that row's own files rather than a row id it would have to trust and resolve itself.
	// The same ref in two messages points at two different snapshots, which is why the row's `at`
	// rides along. Unresolvable, unclaimed, or declined all fall through to the link menu: never a
	// crash, never a silent no-op, never a wrong-row open.
	rendererPool.onClaimedLinkTap = { team, rowId, rowAt, url ->
		val row = repo.state.value.threads[team]?.firstOrNull { it.id == rowId && it.at == rowAt }
		val claimed = row != null &&
			pluginManager.host.linkHandlers.anyCaught(onError = ::logPluginThrow) {
				it.tryOpen(context, TappedLink(team, url, row.files))
			}
		if (!claimed) {
			linkMenuNote = "No code snapshot is attached to this message."
			linkMenu = team to url
		}
	}
	// Claimed schemes decide which links render as live rather than broken; re-pushed on a toggle.
	rendererPool.handledSchemes = pluginManager.host.linkHandlers.values().map { it.scheme }
	DisposableEffect(Unit) {
		// Fires on the player's daemon thread; the pool's renderer map is
		// main-owned, so hop through the composition scope (main-dispatched).
		// An event is a nudge to re-read, not a fact to accumulate. Asking the repository what is true
		// now means this cannot drift from it - the version that tracked generations itself was wrong
		// twice, once blanking a row still playing and once stranding one that had ended.
		val glyphs = repo.stts.addListener { event ->
			val team = event.team
			scope.launch { rendererPool.setPlayStates(team, repo.playback.playStatesFor(team)) }
		}
		onDispose { repo.stts.removeListener(glyphs) }
	}
	// And again once the queue has SETTLED. A raw playback event fires before the terminal it reports
	// has advanced the queue, so a row painted from it can show the state from just before the advance
	// with no later event to correct it - the same pre-settle race the transport hit, answered the same
	// way. Every open tab, since one terminal can start a message in a different thread.
	LaunchedEffect(Unit) {
		repo.playback.queueRevision.collect {
			for (team in repo.state.value.openTabs) rendererPool.setPlayStates(team, repo.playback.playStatesFor(team))
		}
	}
	val dark = isSystemInDarkTheme()
	LaunchedEffect(dark) { rendererPool.setDark(dark) }
	LaunchedEffect(state.openTabs) { rendererPool.retain(state.openTabs.toSet()) }
	DisposableEffect(Unit) { onDispose { rendererPool.destroyAll() } }

	return rendererPool
}
