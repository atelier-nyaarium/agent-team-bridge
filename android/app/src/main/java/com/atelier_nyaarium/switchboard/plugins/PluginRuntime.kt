package com.atelier_nyaarium.switchboard.plugins

/**
 * One instance owns the plugin framework's shared state: the source-context stack, the lifecycle
 * bus, and every registry created through it. The app holds a single instance (see [Plugins]);
 * tests mint fresh ones, so no framework state is process-global.
 */
class PluginRuntime {
	val context = SourceContext()
	val lifecycle = PluginLifecycleBus(context)

	/** Create an extension-point registry wired into the retract sweep. The creating code holds
	 * the typed reference (there is no lookup-by-name, so no erased-cast surface); a registry
	 * created inside a plugin's own registration window is torn down with that plugin. */
	fun <T : Any> createRegistry(name: String): PluginRegistry<T> {
		val registry = PluginRegistry<T>(name, context)
		lifecycle.onRetract { registry.retractSource(it) }
		return registry
	}
}
