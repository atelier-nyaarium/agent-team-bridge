package com.atelier_nyaarium.switchboard.plugins.designer

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/** One request to open a specific card in the Designer viewer, raised when a card-marked
 * attachment chip is tapped in the chat body. */
data class DesignerOpenRequest(val team: String, val rel: String)

/**
 * Process-scoped hand-off from the attachment-chip tap (handled by the Designer's `AttachmentOpener`,
 * off in the app's tap path) to the live [DesignerDock] for the open thread, which owns the viewer
 * UI. An EVENT stream (replay 0), not a retained value: a re-mounted dock only sees FUTURE taps, so
 * re-entering a conversation can never auto-open a canvas from a stale request. Each event carries
 * its team so a dock ignores a tap meant for another thread. Kept out of the plugin registries
 * because it is transient UI intent, not a registered contribution.
 */
object DesignerOpenBus {
	private val _events = MutableSharedFlow<DesignerOpenRequest>(replay = 0, extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)
	val events: SharedFlow<DesignerOpenRequest> = _events

	fun request(team: String, rel: String) {
		_events.tryEmit(DesignerOpenRequest(team, rel))
	}
}

/** A process-lifetime scope for a Designer fire-and-forget send (Reattach), so closing the thread
 * mid-send does not cancel it - matching the composer's own App-scoped send rather than the dock's
 * composition scope. */
internal val designerSendScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
