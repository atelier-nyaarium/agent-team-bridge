package com.atelier_nyaarium.switchboard

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

////////////////////////////////
//  Interfaces & Types

/**
 * A Gateway this owner admitted whose bundle was never confirmed delivered.
 *
 * The admission goes out before any delivery is attempted, and it HAS to: the sealed bundle carries
 * that same admission inside it, so rolling it back on a failed delivery would break the paste
 * fallback that is the whole recovery path. An interrupted enrollment therefore leaves a real member
 * in the keyring that never received a byte, and without this record the Gateways screen cannot tell
 * that apart from a machine that is simply switched off.
 *
 * Keeping the sealed bundle is what makes resuming free of a re-scan. It is sealed to that Gateway's
 * box key and readable by nothing else, and the same bytes already reach the clipboard on the paste
 * path, so holding them here costs no secrecy that was not already spent.
 */
@Serializable
internal data class PendingEnroll(
	val gatewayId: String,
	/** The sealed bootstrap frame. Bound to the arming nonce it was sealed against, so it dies the
	 * moment that Gateway arms again; a resume past that point needs a fresh scan, not these bytes. */
	val bundle: String,
	val lanHost: String? = null,
	val lanPort: Int? = null,
	val certFp: String? = null,
	val at: Long = 0L,
	/** What the last delivery attempt said, so a card can show WHY rather than only that it stalled. */
	val lastError: String? = null,
) {
	/** Whether a resume can post this itself, or can only hand the bundle over to be pasted. */
	val deliverable: Boolean
		get() = lanHost != null && lanPort != null && certFp != null
}

/** What a Gateways card says about one member. */
internal sealed interface GatewayCardState {
	data class Live(val sessions: Int) : GatewayCardState

	data object Offline : GatewayCardState

	data class Unfinished(val lastError: String?) : GatewayCardState
}

////////////////////////////////
//  Functions & Helpers

/**
 * What a Gateways card shows, given what the session list says and whether an enrollment is still
 * outstanding. Pure, so the precedence is testable without Compose.
 *
 * A session outranks a pending record deliberately. It is proof the Gateway installed its bundle and
 * registered at some point, which a stale record cannot argue with; the record only speaks when
 * nothing else has ever spoken for that Gateway.
 */
internal fun gatewayCardState(sessions: Int, online: Boolean, pending: PendingEnroll?): GatewayCardState =
	when {
		online -> GatewayCardState.Live(sessions)
		sessions > 0 -> GatewayCardState.Offline
		pending != null -> GatewayCardState.Unfinished(pending.lastError)
		else -> GatewayCardState.Offline
	}

// Its own lenient instance rather than the wire one: this is local state, and a field added later
// must degrade to a default here rather than making the whole file unreadable.
private val pendingJson = Json {
	ignoreUnknownKeys = true
	encodeDefaults = true
}

private val pendingSerializer = MapSerializer(String.serializer(), PendingEnroll.serializer())

internal fun encodePendingEnrolls(map: Map<String, PendingEnroll>): String =
	pendingJson.encodeToString(pendingSerializer, map)

/** Tolerant by design: a corrupt or half-written blob answers empty rather than throwing, since the
 * worst case of losing this is a card that says offline instead of unfinished. */
internal fun decodePendingEnrolls(text: String?): Map<String, PendingEnroll> {
	if (text.isNullOrBlank()) return emptyMap()
	return runCatching { pendingJson.decodeFromString(pendingSerializer, text) }.getOrDefault(emptyMap())
}
