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

	/** Set by the owner; receives the attachments-relative path of a tapped
	 * attachment (the in-app viewer). When unset, taps fall back to the system
	 * "Open with" chooser. */
	var onAttachmentTap: ((String) -> Unit)? = null

	/** Set by the owner; called with (team, message at) when an agent row's
	 * Play button is tapped. */
	var onPlayTap: ((String, Long) -> Unit)? = null

	/** Whether agent rows render Play buttons. Set before threads first sync. */
	var playEnabled = false

	/** Set by the owner; maps a message's `from` canonical address to a human label. Forwarded to
	 * every renderer, read at render time, so setting it after renderers exist still takes effect. */
	var resolveFrom: ((String) -> String)? = null

	/** Set by the owner; the local user's own display name. Forwarded to every renderer, read at
	 * render time, so a device rename reflects without rebuilding the pool. */
	var selfLabel: (() -> String)? = null

	fun get(team: String): ThreadRenderer =
		renderers.getOrPut(team) {
			ThreadRenderer(context).also {
				it.setDark(dark)
				it.playEnabled = playEnabled
				it.onOpenAttachment = { rel -> onAttachmentTap?.invoke(rel) ?: openAttachment(rel) }
				it.onRetryMessage = { id -> onRetry?.invoke(team, id) }
				it.onPlayMessage = { at -> onPlayTap?.invoke(team, at) }
				it.resolveFrom = { addr -> resolveFrom?.invoke(addr) ?: addr }
				it.selfLabel = { selfLabel?.invoke() ?: "" }
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
