package com.atelier_nyaarium.switchboard.plugins

/**
 * The "which plugin is registering right now?" stack (nyaadot's SourceContext). [PluginManager]
 * wraps each plugin's entry hook in [with], so every claim a plugin makes inside its registration
 * window is tagged with the plugin's id WITHOUT the plugin saying so - the tag is what the one-sweep
 * retract removes on disable, so a toggled-off plugin cannot leak a registration by forgetting to
 * name itself.
 *
 * Registration is main-thread by contract (boot and settings toggles); the stack is not
 * thread-safe by design.
 */
class SourceContext {
	private val stack = ArrayDeque<String>()

	/** The registering plugin's composite id, or "" outside any registration window. */
	fun current(): String = stack.lastOrNull() ?: ""

	fun inContext(): Boolean = stack.isNotEmpty()

	/** Run [block] with [id] as the active source. Always pops, even on throw, so a failed
	 * registration cannot leave the stack poisoned for the next plugin. */
	fun <T> with(id: String, block: () -> T): T {
		stack.addLast(id)
		try {
			return block()
		} finally {
			stack.removeLast()
		}
	}
}

/** The implicit source for a claim made outside any plugin registration window (core code
 * wiring its own extension points). Core claims are never swept by a plugin retract. */
const val CORE_SOURCE = "core"
