package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider

/**
 * Holds one ThreadRenderer (one WebView) per open thread, keyed by team. The pool
 * lives outside composition so a WebView survives ThreadScreen leaving the tree
 * (back to Sessions, tab switches), keeping each thread's scroll position and
 * rendered DOM. The owner prunes it to the open-tab set; closing a tab destroys
 * that WebView. The pool is Activity-scoped, so it and its WebViews are released
 * with the Activity (no leak of a stale context across recreation).
 */
class ThreadRendererPool(private val context: Context) {
	private val renderers = mutableMapOf<String, ThreadRenderer>()
	private var dark = false

	/** Set by the owner; called with (team, row id) when a failed send's retry
	 * badge is tapped in that team's thread. */
	var onRetry: ((String, Long) -> Unit)? = null

	/** Set by the owner; receives the (team, attachments-relative path) of a tapped attachment (the
	 * in-app viewer). The team is bound per-renderer, so it is always the thread the tap came from,
	 * not whatever is on-screen when the posted callback runs. When unset, taps fall back to the
	 * system "Open with" chooser. */
	var onAttachmentTap: ((String, String) -> Unit)? = null

	/** Set by the owner; called with (team, message at) when an agent row's
	 * Play button is tapped. */
	var onPlayTap: ((String, Long) -> Unit)? = null

	/** Set by the owner; called with (team, row id, row at) when a thread's scroll-driven read
	 * pointer reports a new highest-read row. The team is bound per-renderer, same as
	 * [onAttachmentTap], so a late debounced report after a tab switch credits the right thread. */
	var onReadUpTo: ((String, Long, Long) -> Unit)? = null

	/** Set by the owner; called with (team, href) when a link in that team's thread is tapped.
	 * The team is bound per-renderer, same as [onAttachmentTap] - a custom protocol acting on the
	 * thread's own host project needs to know which thread the link came from. */
	var onLinkTap: ((String, String) -> Unit)? = null

	/** Set by the owner; called with (team, href) when a link is long-pressed (the open/copy
	 * context menu). Team-bound like [onLinkTap]. */
	var onLinkLongPress: ((String, String) -> Unit)? = null

	/** Whether agent rows render Play buttons. Set before threads first sync. */
	var playEnabled = false

	/** Set by the owner; maps a message's `from` canonical address to a human label. Forwarded to
	 * every renderer, read at render time, so setting it after renderers exist still takes effect. */
	var resolveFrom: ((String) -> String)? = null

	/** Set by the owner; the local user's own display name. Forwarded to every renderer, read at
	 * render time, so a device rename reflects without rebuilding the pool. */
	var selfLabel: (() -> String)? = null

	/** Set by the owner; returns decoration data for a (team, file) chip, or null for the plain
	 * chip. The team is bound per-renderer, same as [onAttachmentTap]. Runs on the main thread
	 * inside serialization - in-memory lookups only. */
	var decorateFile: ((String, MessageFile) -> ChipDecoration?)? = null

	fun get(team: String): ThreadRenderer =
		renderers.getOrPut(team) {
			ThreadRenderer(context).also {
				it.setDark(dark)
				it.playEnabled = playEnabled
				it.onOpenAttachment = { rel -> onAttachmentTap?.invoke(team, rel) ?: openAttachment(rel) }
				it.onRetryMessage = { id -> onRetry?.invoke(team, id) }
				it.onPlayMessage = { at -> onPlayTap?.invoke(team, at) }
				it.onReadUpTo = { id, at -> onReadUpTo?.invoke(team, id, at) }
				it.onLinkTap = { url -> onLinkTap?.invoke(team, url) }
				it.onLinkLongPress = { url -> onLinkLongPress?.invoke(team, url) }
				it.resolveFrom = { addr -> resolveFrom?.invoke(addr) ?: addr }
				it.selfLabel = { selfLabel?.invoke() ?: "" }
				it.decorateFile = { f -> decorateFile?.invoke(team, f) }
			}
		}

	/** Push the now-playing message to one team's renderer (null = stopped). */
	fun setPlaying(team: String, at: Long?) {
		renderers[team]?.setPlaying(at)
	}

	/** System "Open with" chooser for a validated attachment path. */
	fun openWith(relPath: String) = openAttachment(relPath)

	/** Replace a crashed renderer with a fresh one; the caller re-feeds the transcript. */
	fun recreate(team: String): ThreadRenderer {
		renderers.remove(team)?.destroy()
		return get(team)
	}

	/** Open a tapped attachment in the system viewer/share sheet. The rel path is
	 * validated to stay inside the attachments directory before any URI is granted. */
	private fun openAttachment(relPath: String) {
		val file = Attachments.resolve(context.filesDir, relPath) ?: return
		val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
		val mime = context.contentResolver.getType(uri) ?: "*/*"
		val view = Intent(Intent.ACTION_VIEW)
			.setDataAndType(uri, mime)
			.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
		val chooser = Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
		runCatching { context.startActivity(chooser) }
	}

	fun setDark(value: Boolean) {
		dark = value
		for (r in renderers.values) r.setDark(value)
	}

	/** Push the app foreground/background transition to every open thread's renderer. */
	fun setVisible(visible: Boolean) {
		for (r in renderers.values) r.setVisible(visible)
	}

	/** Destroy any renderer whose thread is no longer open. */
	fun retain(openTeams: Set<String>) {
		val gone = renderers.keys - openTeams
		for (team in gone) renderers.remove(team)?.destroy()
	}

	fun destroyAll() {
		for (r in renderers.values) r.destroy()
		renderers.clear()
	}
}
