package com.atelier_nyaarium.switchboard.plugins

import androidx.compose.runtime.Composable

/**
 * A plugin's compiled entry hook - the transform of nyaadot's `entry_point` script for a runtime
 * that must not load code (plans/plugins.md, "nyaadot keep / toss"). [PluginManager] runs it
 * inside the plugin's [SourceContext] window on every enable, so each claim it makes auto-tags;
 * disable sweeps those claims, and a re-enable runs it again against clean registries.
 */
fun interface PluginEntry {
	fun register(host: PluginHost)
}

/** A composable slot rendered between a thread's message list and its composer. It receives the
 * open thread's canonical team address and draws nothing when it has nothing to show. */
typealias ThreadDockSlot = @Composable (team: String) -> Unit

/**
 * What a plugin's entry hook is GIVEN to touch, growing one typed extension point at a time as
 * real consumers arrive. This is the sanctioned surface, not a security boundary: baked-in
 * plugins compile into the same module as the framework and are first-party trusted code. The
 * host exists to make the right way the easy way - a plugin never NEEDS to reach the runtime's
 * own machinery, and the runtime is private here so it cannot do so through the host.
 */
class PluginHost internal constructor(
	private val runtime: PluginRuntime,
) {
	/** Thread-dock contributions, keyed `<plugin>:<slot>`. The Designer's dock is the first
	 * consumer; ThreadScreen renders every claimed slot in claim order. */
	val threadDockSlots: PluginRegistry<ThreadDockSlot> = runtime.createRegistry("thread-dock-slots")
}
