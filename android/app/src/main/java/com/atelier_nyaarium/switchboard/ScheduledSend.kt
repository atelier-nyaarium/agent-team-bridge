package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.JsonObject

////////////////////////////////
//  Interfaces & Types

/**
 * A banked send waiting for its wall-clock time, at most one per team.
 *
 * `opId` is minted at schedule time and carried all the way to `deliver()`, so the gateway's
 * idempotency cache covers this fire like any live send. `targetDomainId` is resolved once at
 * schedule time because `deliver()`'s own resolution reads `state.teams`, which is empty on a cold
 * fire until `connect()` completes, so re-deriving it would silently break a cross-Domain target.
 * `fileRefs` point at an eagerly-copied bucket so a transient `content://` grant need not outlive
 * the wait.
 */
data class ScheduledSend(
	val text: String,
	val fileRefs: List<MessageFile>,
	val fireAtMillis: Long,
	val opId: String,
	val targetDomainId: String?,
	val createdAt: Long,
)

/**
 * The service-owned alarm side effects a scheduled send needs, mirroring [DeepIdleScheduler]'s seam
 * so [ChatRepository] never needs a raw Context.
 *
 * [scheduleNext] and [cancelNext] arm the single shared next-due wakeup, always the earliest pending
 * record across every team. [scheduleRetry] arms one team's bounded one-shot retry after a failed
 * fire, keyed per team rather than in a shared slot, so two teams failing at once cannot clobber
 * each other.
 */
interface ScheduledSendAlarmScheduler {
	fun scheduleNext(atMillis: Long)

	fun cancelNext()

	fun scheduleRetry(atMillis: Long, team: String, opId: String, targetDomainId: String?)
}

/** A data-plane consumer of new inbound messages, invoked once per message at the drain gate. */
fun interface InboundSubscriber {
	fun onMessage(team: String, msg: Message)
}

/** A consumer of arrived `plugin_action` mailbox entries, invoked once per entry at the drain gate.
 * Deliberately carries no plugin types: the plugin-framework bridge maps these fields onto its own
 * claim-keyed dispatch. */
fun interface PluginActionSubscriber {
	fun onAction(team: String, pluginId: String, actionType: String, payload: JsonObject?)
}
