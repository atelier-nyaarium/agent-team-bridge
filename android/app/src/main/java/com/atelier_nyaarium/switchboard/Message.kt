package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

data class Message(
	val fromMe: Boolean,
	val text: String,
	val at: Long,
	/** A per-thread, local-only row key for the WebView DOM, which lets the renderer replace a row in
	 * place. NOT the mailbox seq; mailbox dedupe is owned by SyncCursor. */
	val id: Long = 0,
	val files: List<MessageFile> = emptyList(),
	/** Wire "running"/"error", local "pending" (echo in flight), or null once settled. */
	val status: String? = null,
	/** The relay opId this send was first delivered under. A retry reuses it so the gateway replays a
	 * lost reply instead of double-delivering to the agent. */
	val opId: String? = null,
	/** Notification-bar line for a notice. The thread renders the body as usual and never shows this. */
	val title: String? = null,
	/** The Short tier of a notice, persisted but not yet read by any UI. */
	val summary: String? = null,
	/** What the FULL play tier speaks in `text`'s place. */
	val fullSpoken: String? = null,
	/** Mailbox coordinates of the entry that produced this row, so an at-least-once re-drain renders
	 * exactly once. Zero for local, optimistic and legacy persisted rows. */
	val epoch: Long = 0,
	val seq: Long = 0,
	/** The canonical author header for an inbound row, null for our own. Not persisted for an ordinary
	 * row (every thread has one fixed peer, so it is re-derived from the thread key on load); a peer
	 * mirror is the exception, since its two parties are independent of the thread it is filed under. */
	val from: String? = null,
	/** The other party of a peer-mirror row, when it resolved. May be null on a peer row, so `isPeer`
	 * is the discriminator rather than this field's presence. */
	val to: String? = null,
	/** Whether this row is an agent-to-agent exchange mirrored into this thread rather than a message
	 * addressed to this console. Drives both persistence and how the row is labelled. */
	val isPeer: Boolean = false,
	/** Whether this row arrived while the app was visible. Process-transient, NEVER persisted. Drives
	 * thread.js's arrival suppression: a batch containing an unread-eligible row that arrived while
	 * hidden holds the reader's position instead of auto-following. */
	val arrivedVisible: Boolean = true,
)

/** The rendered `from`/`to`/`isPeer` for a non-`"sent"` mailbox entry. */
internal data class MessageAttribution(val from: String?, val to: String?, val isPeer: Boolean)

////////////////////////////////
//  Functions & Helpers

/** The tier-field invariant applied at Message's two construction boundaries: a tier is null or
 * non-blank, never "". The wire below the tool schemas is lenient for mixed-version grace, so
 * normalizing here lets every consumer chain a plain `?:` with no per-site blank guard. */
internal fun String?.tierOrNull(): String? = this?.takeIf { it.isNotBlank() }

/** An ordinary entry collapses to the thread's own fixed peer. A `"peer"` mirror's own `from`/`to`
 * are the real two parties, so those are resolved instead; `isPeer` is set whenever `kind` says so
 * even if `to` fails to resolve, or a peer row's `from` would read as an ordinary row downstream.
 * `canonicalize` stands in for address resolution so this stays pure. */
internal fun resolveMessageAttribution(
	kind: String,
	entryFrom: String?,
	entryTo: String?,
	team: String,
	canonicalize: (String) -> String?,
): MessageAttribution =
	if (kind == "peer") {
		MessageAttribution(entryFrom?.let(canonicalize) ?: team, entryTo?.let(canonicalize), isPeer = true)
	} else {
		MessageAttribution(team, null, isPeer = false)
	}

/** What a Message's `from`/`to` are written as in persisted JSON. Keyed on `isPeer`, not on `to`'s
 * presence: a peer row's `to` can be null while its `from` is still real and worth keeping. */
internal fun persistedAttribution(m: Message): Pair<String?, String?> =
	if (m.isPeer) m.from to m.to else null to null

/** The inverse of [persistedAttribution]. An ordinary row's author re-derives from the thread key,
 * holding the single-peer-per-thread invariant. */
internal fun loadedAttribution(
	persistedFrom: String?,
	persistedTo: String?,
	isPeer: Boolean,
	isMe: Boolean,
	canonicalKey: String,
): Pair<String?, String?> =
	when {
		isMe -> null to null
		isPeer -> (persistedFrom ?: canonicalKey) to persistedTo
		else -> canonicalKey to null
	}

/** The thread index a `sent` echo should replace, or -1 to append. Folds an at-least-once re-drain by
 * (epoch, seq), then matches this owner's row by opId whatever its current seq, so a duplicate echo
 * from a reconcile re-send folds onto the already-upgraded row instead of stranding a second copy. */
internal fun sentEchoMatch(thread: List<Message>, echo: Message): Int {
	if (echo.seq > 0) {
		val bySeq = thread.indexOfFirst { it.seq == echo.seq && it.epoch == echo.epoch }
		if (bySeq >= 0) return bySeq
	}
	if (echo.opId != null) return thread.indexOfFirst { it.fromMe && it.opId == echo.opId }
	return -1
}
