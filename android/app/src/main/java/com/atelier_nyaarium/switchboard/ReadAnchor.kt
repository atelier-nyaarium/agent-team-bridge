package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/** The persisted per-team read anchor, a mailbox journal coordinate. Resolved to its row by EQUALITY
 * only: mailbox epochs are random per instance and never ordered, so comparing them numerically is
 * unsound. `at` rides along for diagnostics. */
data class ReadAnchor(val epoch: Long, val seq: Long, val at: Long)

////////////////////////////////
//  Functions & Helpers

/** A `sent` echo also carries seq > 0, being the owner's own message mirrored to their devices, so
 * unread is never a bare seq check. */
internal fun Message.countsUnread(): Boolean = !fromMe && seq > 0L

/** The anchor's row index in arrival order, or -1 when there is no anchor or its row is gone. Every
 * inbound row then counts, and any receipt reads as a genuine advance. */
internal fun anchorIndex(thread: List<Message>, anchor: ReadAnchor?): Int {
	if (anchor == null) return -1
	return thread.indexOfFirst { it.epoch == anchor.epoch && it.seq == anchor.seq }
}

/** Inbound rows positioned strictly after the anchor's row. */
internal fun unreadCount(thread: List<Message>, anchor: ReadAnchor?): Int {
	val idx = anchorIndex(thread, anchor)
	return thread.withIndex().count { (i, m) -> i > idx && m.countsUnread() }
}

/** The unread rows themselves, in thread order. The notification's preview lines and Play actions
 * derive from this rather than a stale burst list, so a mid-drain refresh stays accurate. */
internal fun unreadRows(thread: List<Message>, anchor: ReadAnchor?): List<Message> {
	val idx = anchorIndex(thread, anchor)
	return thread.filterIndexed { i, m -> i > idx && m.countsUnread() }
}

internal fun firstUnreadId(thread: List<Message>, anchor: ReadAnchor?): Long? {
	val idx = anchorIndex(thread, anchor)
	return thread.withIndex().firstOrNull { (i, m) -> i > idx && m.countsUnread() }?.value?.id
}

/** Resolve a reported "read up to" row to the anchor it implies: the row itself if it counts, else
 * the nearest earlier inbound row, so a reported pending send still marks everything above it read.
 * The `at` check stops an id reused after a forget sweep from wrongly crediting. */
internal fun resolveReportedAnchor(thread: List<Message>, rowId: Long, reportedAt: Long): ReadAnchor? {
	val idx = thread.indexOfFirst { it.id == rowId }
	if (idx < 0 || thread[idx].at != reportedAt) return null
	for (i in idx downTo 0) {
		val m = thread[i]
		if (m.countsUnread()) return ReadAnchor(m.epoch, m.seq, m.at)
	}
	return null
}

/** The anchor a deliberate mark-read (a notification swipe-away) advances to. */
internal fun lastInboundAnchor(thread: List<Message>): ReadAnchor? =
	thread.lastOrNull { it.countsUnread() }?.let { ReadAnchor(it.epoch, it.seq, it.at) }

/** Whether `candidate` is a genuine advance over `current`. An unresolvable `current` is index -1,
 * so a receipt for any resolvable row always advances and nothing deadlocks. */
internal fun isAnchorAdvance(thread: List<Message>, current: ReadAnchor?, candidate: ReadAnchor): Boolean {
	val candidateIdx = thread.indexOfFirst { it.epoch == candidate.epoch && it.seq == candidate.seq }
	if (candidateIdx < 0) return false
	return candidateIdx > anchorIndex(thread, current)
}

/** Re-anchor a sibling thread whose anchor row [threadsAfterForget] swept away. Falls back by `at`
 * rather than by position, since the removed row's position no longer exists in `newThread`. */
internal fun reanchorAfterForget(newThread: List<Message>, anchor: ReadAnchor?): ReadAnchor? {
	if (anchor == null || anchorIndex(newThread, anchor) >= 0) return anchor
	return newThread.lastOrNull { it.countsUnread() && it.at <= anchor.at }?.let { ReadAnchor(it.epoch, it.seq, it.at) }
}

/** Teams whose local anchor has advanced past what this device last reported to the read-anchor sync
 * plane. A team absent from `lastReported` needs reporting only if its current anchor differs. */
internal fun teamsNeedingReadReport(readAnchors: Map<String, ReadAnchor>, lastReported: Map<String, ReadAnchor>): List<String> =
	readAnchors.filter { (team, anchor) ->
		val already = lastReported[team]
		already == null || already.epoch != anchor.epoch || already.seq != anchor.seq
	}.keys.toList()
