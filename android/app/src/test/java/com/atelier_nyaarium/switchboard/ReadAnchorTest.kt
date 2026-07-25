package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The read-anchor pure functions the scroll-driven unread model is built on. Mailbox epochs are
 * random per instance (device-mailbox.ts) and never ordered, so every derivation here resolves the
 * anchor to its row by (epoch, seq) EQUALITY and counts POSITIONALLY - never by comparing epoch or
 * seq numerically across rows from different instances.
 */
class ReadAnchorTest {
	private fun inbound(epoch: Long, seq: Long, at: Long = seq, id: Long = seq) =
		Message(fromMe = false, text = "in", at = at, id = id, epoch = epoch, seq = seq)

	private fun ownSend(at: Long, id: Long) = Message(fromMe = true, text = "me", at = at, id = id)

	private fun sentEcho(epoch: Long, seq: Long, at: Long, id: Long) =
		Message(fromMe = true, text = "me", at = at, id = id, epoch = epoch, seq = seq)

	@Test
	fun crossEpochAnchorResolvesByEqualityNotNumericOrder() {
		// A new mailbox instance can mint a SMALLER random epoch than the old one - epoch 2 sorting
		// "before" epoch 9 numerically must not affect the count, which is purely positional.
		val thread = listOf(inbound(epoch = 9, seq = 1, id = 0), inbound(epoch = 2, seq = 1, id = 1))
		val anchor = ReadAnchor(epoch = 9, seq = 1, at = 1)
		assertEquals(0, anchorIndex(thread, anchor))
		assertEquals(1, unreadCount(thread, anchor))
		assertEquals(1L, firstUnreadId(thread, anchor))
	}

	@Test
	fun sentEchoNeverCountsDespiteCarryingRealCoordinates() {
		// A `sent` mirror (fromMe=true) also carries seq > 0 - it must never count as unread, even
		// though the genuinely inbound row before it does.
		val thread = listOf(inbound(epoch = 1, seq = 1, id = 0), sentEcho(epoch = 1, seq = 2, at = 2, id = 1))
		assertEquals(1, unreadCount(thread, null))
		assertEquals(0L, firstUnreadId(thread, null))
	}

	@Test
	fun missingAnchorCountsEveryInboundRow() {
		// A brand-new team (no anchor entry at all) badges its first message immediately - the
		// runtime "no anchor" rule, distinct from the one-shot migration seed.
		val thread = listOf(inbound(epoch = 1, seq = 1, id = 0), inbound(epoch = 1, seq = 2, id = 1))
		assertEquals(2, unreadCount(thread, null))
		assertEquals(-1, anchorIndex(thread, null))
	}

	@Test
	fun unresolvableAnchorRowCountsEverythingAndAlwaysAdvances() {
		// The anchor's row is gone (forgotten sweep, corrupt store) - treated as index -1: every
		// inbound row counts, and ANY resolvable receipt is a genuine advance (no deadlock).
		val thread = listOf(inbound(epoch = 1, seq = 1, id = 0))
		val goneAnchor = ReadAnchor(epoch = 99, seq = 99, at = 99)
		assertEquals(-1, anchorIndex(thread, goneAnchor))
		assertEquals(1, unreadCount(thread, goneAnchor))
		val candidate = ReadAnchor(epoch = 1, seq = 1, at = 1)
		assertTrue(isAnchorAdvance(thread, goneAnchor, candidate))
	}

	@Test
	fun foldInversionStillResolvesToZeroAtTheBottomRegionRow() {
		// An in-place fold (reconcileSent settling an echo, a re-drain folding by mailbox) keeps a row
		// at its OLD position while adopting a seq higher than a peer row appended after it - row order
		// and seq order invert. Reading the bottom REGION row must still resolve to fully-read.
		val thread = listOf(
			inbound(epoch = 1, seq = 20, at = 20, id = 5), // folded in place; now carries seq 20
			inbound(epoch = 1, seq = 10, at = 10, id = 6), // a peer row appended meanwhile, seq 10 < 20
		)
		// Reading the bottom region row (id=6, the peer row) by report.
		val anchor = resolveReportedAnchor(thread, rowId = 6, reportedAt = 10)
		assertEquals(ReadAnchor(1, 10, 10), anchor)
		// The anchor resolves to id=6's own index (1), so BOTH id=6 and the earlier id=5 (index 0)
		// count as read - even though id=5's seq (20) is numerically higher than id=6's (10),
		// proving the count is purely positional, never seq-ordered.
		assertEquals(1, anchorIndex(thread, anchor))
		assertEquals(0, unreadCount(thread, anchor))
	}

	@Test
	fun resolveReportedAnchorWalksBackFromAFromMeOrPendingBottomRow() {
		val thread = listOf(
			inbound(epoch = 1, seq = 1, at = 1, id = 0),
			ownSend(at = 2, id = 1), // the local optimistic send: fromMe, seq == 0
		)
		val anchor = resolveReportedAnchor(thread, rowId = 1, reportedAt = 2)
		assertEquals(ReadAnchor(1, 1, 1), anchor)
	}

	@Test
	fun resolveReportedAnchorDropsAnAbsentRowId() {
		val thread = listOf(inbound(epoch = 1, seq = 1, id = 0))
		assertNull(resolveReportedAnchor(thread, rowId = 999, reportedAt = 1))
	}

	@Test
	fun resolveReportedAnchorDropsAMismatchedAt() {
		// A forget sweep can free an id for reuse by a later append; a stale debounced report
		// naming the old `at` must not credit the new row.
		val thread = listOf(inbound(epoch = 1, seq = 1, at = 1, id = 0))
		assertNull(resolveReportedAnchor(thread, rowId = 0, reportedAt = 999))
	}

	@Test
	fun positionalMonotonicityRejectsARegressionAndADuplicate() {
		val thread = listOf(
			inbound(epoch = 1, seq = 1, id = 0),
			inbound(epoch = 1, seq = 2, id = 1),
			inbound(epoch = 1, seq = 3, id = 2),
		)
		val current = ReadAnchor(epoch = 1, seq = 2, at = 2)
		// A candidate at an EARLIER index must not advance.
		assertTrue(!isAnchorAdvance(thread, current, ReadAnchor(1, 1, 1)))
		// A duplicate report of the SAME row must not (re-)advance either.
		assertTrue(!isAnchorAdvance(thread, current, ReadAnchor(1, 2, 2)))
		// A genuinely later row does advance.
		assertTrue(isAnchorAdvance(thread, current, ReadAnchor(1, 3, 3)))
	}

	@Test
	fun firstUnreadSkipsAnInterleavedOwnSendRow() {
		// [in0(read), in1(unread), me(own send), in2(unread)] - the "size - unread" shortcut would
		// misindex this; first-unread must be in1, not the own-send row after it.
		val thread = listOf(
			inbound(epoch = 1, seq = 1, at = 1, id = 0),
			inbound(epoch = 1, seq = 2, at = 2, id = 1),
			ownSend(at = 3, id = 2),
			inbound(epoch = 1, seq = 4, at = 4, id = 3),
		)
		val anchor = ReadAnchor(epoch = 1, seq = 1, at = 1)
		assertEquals(1L, firstUnreadId(thread, anchor))
		assertEquals(2, unreadCount(thread, anchor))
	}

	@Test
	fun lastInboundAnchorPicksTheThreadsTailInboundRow() {
		val thread = listOf(
			inbound(epoch = 1, seq = 1, at = 1, id = 0),
			ownSend(at = 2, id = 1),
			inbound(epoch = 1, seq = 3, at = 3, id = 2),
		)
		assertEquals(ReadAnchor(1, 3, 3), lastInboundAnchor(thread))
		assertNull(lastInboundAnchor(listOf(ownSend(at = 1, id = 0))))
	}

	@Test
	fun reanchorAfterForgetIsANoOpWhenTheAnchorStillResolves() {
		val thread = listOf(inbound(epoch = 1, seq = 1, at = 1, id = 0))
		val anchor = ReadAnchor(1, 1, 1)
		assertEquals(anchor, reanchorAfterForget(thread, anchor))
	}

	@Test
	fun reanchorAfterForgetFallsBackToTheNearestSurvivingRowByAt() {
		// The forget sweep removed the anchor's own row; re-anchor to the nearest surviving inbound
		// row at-or-before its old `at`, since the sweep invalidates list position but not `at`.
		val goneAnchor = ReadAnchor(epoch = 9, seq = 9, at = 50)
		val survivingThread = listOf(
			inbound(epoch = 1, seq = 1, at = 10, id = 0),
			inbound(epoch = 1, seq = 2, at = 40, id = 1),
			inbound(epoch = 1, seq = 3, at = 60, id = 2), // after the old anchor's `at` - not eligible
		)
		assertEquals(ReadAnchor(1, 2, 40), reanchorAfterForget(survivingThread, goneAnchor))
	}

	@Test
	fun reanchorAfterForgetReturnsNullWhenNothingSurvivesAtOrBefore() {
		val goneAnchor = ReadAnchor(epoch = 9, seq = 9, at = 5)
		val survivingThread = listOf(inbound(epoch = 1, seq = 1, at = 10, id = 0))
		assertNull(reanchorAfterForget(survivingThread, goneAnchor))
	}

	@Test
	fun teamsNeedingReadReportIncludesATeamNeverReportedBefore() {
		val anchors = mapOf("team-a" to ReadAnchor(1, 10, 1000))
		assertEquals(listOf("team-a"), teamsNeedingReadReport(anchors, emptyMap()))
	}

	@Test
	fun teamsNeedingReadReportExcludesATeamAlreadyReportedAtTheSamePosition() {
		val anchor = ReadAnchor(1, 10, 1000)
		val anchors = mapOf("team-a" to anchor)
		assertEquals(emptyList<String>(), teamsNeedingReadReport(anchors, mapOf("team-a" to anchor)))
	}

	@Test
	fun teamsNeedingReadReportIncludesATeamThatAdvancedSinceItsLastReport() {
		val anchors = mapOf("team-a" to ReadAnchor(1, 20, 2000))
		val lastReported = mapOf("team-a" to ReadAnchor(1, 10, 1000))
		assertEquals(listOf("team-a"), teamsNeedingReadReport(anchors, lastReported))
	}

	@Test
	fun teamsNeedingReadReportIsSelectivePerTeam() {
		val anchors = mapOf(
			"team-a" to ReadAnchor(1, 10, 1000), // unchanged
			"team-b" to ReadAnchor(1, 30, 3000), // advanced
		)
		val lastReported = mapOf("team-a" to ReadAnchor(1, 10, 1000), "team-b" to ReadAnchor(1, 20, 2000))
		assertEquals(listOf("team-b"), teamsNeedingReadReport(anchors, lastReported))
	}

	@Test
	fun teamsNeedingReadReportIgnoresAtWhenComparingAlreadyReportedPositions() {
		// `at` is diagnostic only (see ReadAnchor's own doc) - a re-derivation that lands on the same
		// (epoch, seq) with a different `at` must not re-trigger a report.
		val anchors = mapOf("team-a" to ReadAnchor(1, 10, 9999))
		val lastReported = mapOf("team-a" to ReadAnchor(1, 10, 1000))
		assertEquals(emptyList<String>(), teamsNeedingReadReport(anchors, lastReported))
	}
}
