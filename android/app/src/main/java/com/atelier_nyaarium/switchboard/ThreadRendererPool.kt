package com.atelier_nyaarium.switchboard

import android.content.Context

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

	fun get(team: String): ThreadRenderer =
		renderers.getOrPut(team) { ThreadRenderer(context).also { it.setDark(dark) } }

	/** Replace a crashed renderer with a fresh one; the caller re-feeds the transcript. */
	fun recreate(team: String): ThreadRenderer {
		renderers.remove(team)?.destroy()
		return get(team)
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
