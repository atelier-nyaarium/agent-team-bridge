package com.atelier_nyaarium.switchboard.plugins.references

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/** One request to open a resolved ref in the code viewer, raised by a tap in the chat body. */
data class ReferenceOpenRequest(
	val team: String,
	val entry: RefEntry,
	val file: RefFileEntry,
	/** The snapshot's on-device relative path, already resolved from the tapped row. */
	val rel: String,
	/** What the agent wrote, for the viewer's breadcrumb. */
	val label: String,
)

/**
 * Process-scoped hand-off from the tap (handled in the app's link dispatch) to the viewer.
 *
 * An EVENT stream with no replay, matching `DesignerOpenBus`: a re-mounted screen sees only future
 * taps, so re-entering a conversation can never auto-open a stale reference.
 */
object ReferenceOpenBus {
	private val _events =
		MutableSharedFlow<ReferenceOpenRequest>(replay = 0, extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)
	val events: SharedFlow<ReferenceOpenRequest> = _events

	fun request(request: ReferenceOpenRequest) {
		_events.tryEmit(request)
	}
}
