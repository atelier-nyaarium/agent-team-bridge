package com.atelier_nyaarium.switchboard.plugins

/**
 * The single teardown channel (nyaadot's SourceLifecycleBus). Disabling a plugin is ONE
 * [emitRetract] call; every subscriber (each [PluginRegistry] subscribes at creation) sweeps that
 * plugin's claims. A subscription made INSIDE a plugin's registration window is owned by that
 * plugin and auto-drops after its own retract fires - subscribe IS the registration, so a plugin
 * that forgets to unsubscribe cannot leak a callback past its teardown.
 */
class PluginLifecycleBus internal constructor(private val context: SourceContext) {
	private data class Sub(val owner: String, val callback: (String) -> Unit)

	private val subs = mutableListOf<Sub>()

	/** Subscribe to retracts. The owner is the active [SourceContext] source ("" for core, which
	 * is permanent); a plugin-owned subscription fires for its own retract, then drops. */
	@Synchronized
	fun onRetract(callback: (retractedId: String) -> Unit) {
		subs.add(Sub(context.current(), callback))
	}

	/** Tear down everything [id] registered: walk a defensive snapshot (a callback may subscribe
	 * or retract-cascade during the walk), then drop the subscriptions [id] itself owned. */
	fun emitRetract(id: String) {
		val snapshot = synchronized(this) { subs.toList() }
		snapshot.forEach { it.callback(id) }
		synchronized(this) { subs.removeAll { it.owner == id } }
	}
}
