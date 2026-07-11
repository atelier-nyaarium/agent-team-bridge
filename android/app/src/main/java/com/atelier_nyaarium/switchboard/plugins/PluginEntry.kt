package com.atelier_nyaarium.switchboard.plugins

import android.content.Context
import androidx.compose.runtime.Composable
import com.atelier_nyaarium.switchboard.MessageFile
import java.io.File
import kotlinx.serialization.json.JsonObject

/**
 * A plugin's compiled entry hook - the transform of nyaadot's `entry_point` script for a runtime
 * that must not load code (nyaadot's keep / toss pass). [PluginManager] runs it
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

/** Notified when a thread is forgotten, so a plugin can drop that conversation's own device state
 * (e.g. the Designer's per-conversation card index) instead of leaking it onto a reused address. */
fun interface ThreadForgetHandler {
	fun onForget(context: Context, team: String)
}

/** Notified on a full account wipe (Clear / delete domain), so a plugin can drop ALL of its device
 * state, not just per-thread state. */
fun interface AccountWipeHandler {
	fun onWipe(context: Context)
}

/** A new inbound message, as a data-plane subscriber sees it: NO mailbox coordinates (`epoch`/`seq`)
 * - so the "subscribers never derive an ordinal" invariant is type-enforced, not just documented. */
class InboundMessage(
	val team: String,
	val fromMe: Boolean,
	val isPeer: Boolean,
	val at: Long,
	val files: List<MessageFile>,
	val text: String,
)

/** Processes each genuinely-new inbound message exactly once, on the poll thread, before the
 * mailbox cursor commits. The contract: fast, bounded, non-blocking, idempotent - a slow or hanging
 * handler stalls delivery for the whole app. It is handed `filesDir`, not a `Context`, to DISCOURAGE
 * a reentrant `Repo.get(context)` call back into the repo from inside the drain; this is a convention
 * for first-party handlers, not a hard boundary (a plugin could still capture `host.applicationContext`). */
fun interface InboundMessageHandler {
	fun onMessage(filesDir: File, msg: InboundMessage)
}

/** One dispatch of a generic, agent-initiated plugin action: the target conversation, and the
 * action's opaque payload (each `pluginId:actionType` handler parses its own known shape out of
 * it, the same way the Designer's inbound ingest parses its own attachment shape). */
class PluginAction(
	val team: String,
	val payload: JsonObject?,
)

/** Handles ONE claimed `pluginId:actionType` action, dispatched synchronously on the poll thread,
 * before the mailbox cursor commits - same as [InboundMessageHandler], so the CONTRACT is the same:
 * fast, bounded, non-blocking (a slow or hanging handler stalls delivery for every team's messages
 * in the same poll batch, not just this plugin's; `runCatching` at the dispatch site only guards a
 * thrown exception, never a hang or slow IO). MANDATORY ADDITIONAL CONTRACT: idempotent - unlike
 * [InboundMessageHandler], a plugin action has no persisted at-most-once fold (it never renders a
 * chat message, so it cannot ride `appendInbound`'s dedup), so the mailbox's at-least-once delivery
 * can redispatch the SAME action; a handler must treat a duplicate dispatch of the same payload as a
 * safe no-op. */
fun interface PluginActionHandler {
	fun onAction(action: PluginAction)
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
	/** The app context, for a plugin's ONE-TIME setup (e.g. initializing a device store). NOT for
	 * per-message work - the data handler is deliberately context-free (see `InboundMessageHandler`). */
	val applicationContext: Context,
) {
	/** Thread-dock contributions, keyed `<plugin>:<slot>`. The Designer's dock is the first
	 * consumer; ThreadScreen renders every claimed slot in claim order. */
	val threadDockSlots: PluginRegistry<ThreadDockSlot> = runtime.createRegistry("thread-dock-slots")

	/** Attachment-open claimants, keyed `<plugin>:<opener>`. ThreadScreen consults these before
	 * its default attachment viewer; the first to claim wins. */
	val attachmentOpeners: PluginRegistry<AttachmentOpener> = runtime.createRegistry("attachment-openers")

	/** Thread-forget handlers, keyed `<plugin>:<handler>`. The app invokes every handler when a
	 * thread is forgotten so a plugin can drop that conversation's device state. */
	val threadForgetHandlers: PluginRegistry<ThreadForgetHandler> = runtime.createRegistry("thread-forget-handlers")

	/** Account-wipe handlers, keyed `<plugin>:<handler>`. The app invokes every handler on a full
	 * wipe so a plugin can drop all of its device state. */
	val accountWipeHandlers: PluginRegistry<AccountWipeHandler> = runtime.createRegistry("account-wipe-handlers")

	/** Inbound-message handlers (the data plane), keyed `<plugin>:<handler>`. The process bridge
	 * fans each new message to every claimed handler; a disabled plugin's claim is swept, so it
	 * stops receiving. The framework's first data-plane point. */
	val inboundMessages: PluginRegistry<InboundMessageHandler> = runtime.createRegistry("inbound-messages")

	/** Plugin-action handlers (an agent-driven command, not a message), keyed `<pluginId>:<actionType>`
	 * - a plugin claims the exact composite key its own actions use. A key with no claimant (an
	 * unknown action type, or the owning plugin disabled) is silently skipped, never an error. */
	val pluginActions: PluginRegistry<PluginActionHandler> = runtime.createRegistry("plugin-actions")
}
