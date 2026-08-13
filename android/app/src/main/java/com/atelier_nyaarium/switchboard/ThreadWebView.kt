package com.atelier_nyaarium.switchboard

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView

////////////////////////////////
//  Composables

/**
 * Hosts a thread's pooled WebView inside a FrameLayout. The renderer is pulled from
 * the pool (so scroll position and rendered DOM survive tab switches and Sessions
 * round-trips) and re-fed incrementally via sync(). A crashed renderer is swapped
 * for a fresh one and re-fed.
 */
@Composable
fun ThreadWebView(
	team: String,
	messages: List<Message>,
	rendererPool: ThreadRendererPool,
	openNonce: Int,
	unreadBoundary: (String) -> Pair<Long?, List<Long>>,
	// (team, at) a queue tile asked to land on, or null for an ordinary open. Carries its team so a
	// stale request cannot scroll a thread it was never about.
	revealAt: Pair<String, Long>?,
	// Cleared once the reveal has been handed to the renderer. Without it the request stays set and
	// re-fires on every later genuine open of that thread, so a notification tap weeks later would
	// still snap to whichever message was once tapped in the queue.
	onRevealed: () -> Unit,
	// Whether the composer holds text: mirrored into the renderer so a failed row's Cancel, which
	// hands its content back to that box, greys out rather than overwriting what is being typed.
	composerOccupied: Boolean,
	modifier: Modifier,
) {
	var renderer by remember(team) { mutableStateOf(rendererPool.get(team)) }
	val filesDir = LocalContext.current.filesDir

	LaunchedEffect(renderer, composerOccupied) { renderer.setComposerOccupied(composerOccupied) }

	DisposableEffect(renderer) {
		renderer.onRendererGone = { renderer = rendererPool.recreate(team) }
		onDispose { renderer.onRendererGone = null }
	}
	// Ongoing delta-sync on every message-list change - unaffected by opens/reveals below, so an
	// already-open thread keeps rendering new arrivals live. `team` is this composable's own stable
	// parameter (never the ambient "currently on screen" team): the JS round-trip inside the reveal
	// effect below can resolve after the user has navigated elsewhere, so closing over anything
	// mutable here would credit or crash on the wrong thread.
	// Keyed on the frame generation as well as the list: a video's frames land after its row is on
	// screen and change nothing the list itself would notice, so without this no sync runs at all.
	// The matching half is in ThreadRenderer's fingerprint, which decides whether the row re-pushes.
	LaunchedEffect(renderer, messages, FrameReadiness.generation) {
		renderer.sync(messages, unreadBoundary(team).first)
	}
	// Frames are extracted lazily and cost several seeks each, so a row renders with its glyph and
	// gains motion later. Deliberately NOT keyed on the generation this marks, which would make each
	// landing set retrigger the whole pass.
	LaunchedEffect(renderer, messages) {
		for (message in messages) {
			for (file in message.files) {
				if (!file.mime.startsWith("video/")) continue
				val key = VideoThumbs.keyFor(file) ?: continue
				// Skip on ANNOUNCED, never on "already on disk". Extraction does not observe
				// cancellation, so an interrupted pass still writes its full set; keying the skip on
				// the files would then make every later pass step over it, leaving the row rendered as
				// a plain file forever with a complete set sitting unused. This also keeps the common
				// case off the disk entirely.
				if (FrameReadiness.versionOf(key) > 0) continue
				val source = Attachments.fileFor(filesDir, file.src) ?: continue
				if (VideoThumbs.ensure(filesDir, key, source).isNotEmpty()) FrameReadiness.mark(key)
			}
		}
	}
	// A genuine open (notification tap, board tap, tab switch onto a different thread, or
	// composition re-entry after a masked surface like terminal mode or settings) re-snaps to the
	// first unread row. Declared AFTER the sync effect so its own (idempotent) sync() call and
	// flush-then-reveal always run against an already-rendered transcript.
	LaunchedEffect(team, renderer, openNonce) {
		renderer.sync(messages, unreadBoundary(team).first)
		renderer.flushThenReveal {
			val (firstUnreadId, region) = unreadBoundary(team)
			renderer.revealFirstUnread(firstUnreadId, region)
			// A queue tile named a specific message, so land on THAT rather than wherever reading
			// happens to have got to. Runs after the unread snap so it wins, and only for the thread the
			// tile pointed at - a tile tapped while a different tab was open must not drag this one.
			//
			// Resolved to the ROW KEY here. A queue entry is identified by its timestamp, but the DOM is
			// keyed by Message.id, a per-thread local key that is deliberately not `at` - handing the
			// timestamp straight to the renderer matched no row at all, so the jump silently did nothing.
			revealAt?.let { (wanted, at) ->
				if (wanted == team) {
					messages.firstOrNull { it.at == at && !it.fromMe }?.let { renderer.revealMessage(it.id) }
					onRevealed()
				}
			}
		}
	}

	AndroidView(
		factory = { ctx -> FrameLayout(ctx) },
		update = { frame ->
			val wv = renderer.webView
			if (wv.parent !== frame) {
				(wv.parent as? ViewGroup)?.removeView(wv)
				frame.removeAllViews()
				frame.addView(
					wv,
					FrameLayout.LayoutParams(
						FrameLayout.LayoutParams.MATCH_PARENT,
						FrameLayout.LayoutParams.MATCH_PARENT,
					),
				)
			}
		},
		modifier = modifier,
	)
}
