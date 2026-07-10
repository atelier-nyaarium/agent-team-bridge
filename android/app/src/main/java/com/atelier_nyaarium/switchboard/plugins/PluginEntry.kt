package com.atelier_nyaarium.switchboard.plugins

import android.content.Context
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

/** What a thread-dock slot is given: the open thread's canonical team address, and a way to seed
 * the composer draft (e.g. the Designer's "Reference in chat" inserting a bold canvas title). The
 * composer state lives in ThreadScreen, so this is the seam a dock uses to reach it. */
class ThreadDockScope(
	val team: String,
	/** Append text to the thread's composer draft. */
	val insertDraftText: (String) -> Unit,
)

/** A composable slot rendered between a thread's message list and its composer. Draws nothing
 * when it has nothing to show for the scope's thread. */
typealias ThreadDockSlot = @Composable (scope: ThreadDockScope) -> Unit

/** Claims an attachment tap. Given the tapped attachment's coordinates, returns true if the
 * plugin will handle opening it (the app then skips its default viewer). Lets the Designer open a
 * card-marked HTML attachment straight into its own viewer instead of the generic file dialog. */
fun interface AttachmentOpener {
	fun tryOpen(context: Context, team: String, rel: String, mime: String, name: String): Boolean
}

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

	/** Attachment-open claimants, keyed `<plugin>:<opener>`. ThreadScreen consults these before
	 * its default attachment viewer; the first to claim wins. */
	val attachmentOpeners: PluginRegistry<AttachmentOpener> = runtime.createRegistry("attachment-openers")
}
