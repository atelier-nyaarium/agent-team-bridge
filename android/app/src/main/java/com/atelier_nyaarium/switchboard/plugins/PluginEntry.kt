package com.atelier_nyaarium.switchboard.plugins

/**
 * A plugin's compiled entry hook - the transform of nyaadot's `entry_point` script for a runtime
 * that must not load code (plans/plugins.md, "nyaadot keep / toss"). [PluginManager] runs it
 * inside the plugin's [SourceContext] window on every enable, so each claim it makes auto-tags;
 * disable sweeps those claims, and a re-enable runs it again against clean registries.
 */
fun interface PluginEntry {
	fun register(host: PluginHost)
}

/**
 * What a plugin's entry hook is GIVEN to touch, growing one typed extension point at a time as
 * real consumers arrive (the Designer adds the first ones). This is the sanctioned surface, not
 * a security boundary: baked-in plugins compile into the same module as the framework and are
 * first-party trusted code. The host exists to make the right way the easy way - a plugin never
 * NEEDS to reach the runtime's own machinery, and the runtime is private here so it cannot do so
 * through the host.
 */
class PluginHost internal constructor(
	@Suppress("unused") // Consumed by the typed extension-point accessors as they are added.
	private val runtime: PluginRuntime,
)
