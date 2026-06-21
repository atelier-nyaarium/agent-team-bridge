package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The `sent`-echo reconcile decision: an owner's own outgoing message is mirrored to all their
 * devices, so the device side must fold an at-least-once re-drain by (epoch, seq), upgrade the
 * SENDING device's optimistic pending row in place by opId, and otherwise append a fresh row.
 */
class SentEchoMatchTest {
	private fun msg(
		fromMe: Boolean,
		opId: String? = null,
		epoch: Long = 0,
		seq: Long = 0,
		status: String? = null,
	) = Message(fromMe = fromMe, text = "x", at = 0, opId = opId, epoch = epoch, seq = seq, status = status)

	@Test
	fun sendingDeviceMatchesOptimisticRowByOpId() {
		val thread = listOf(msg(fromMe = true, opId = "op-1", status = "pending"))
		val echo = msg(fromMe = true, opId = "op-1", epoch = 5, seq = 12)
		// Replaces the optimistic row in place (one row, no duplicate).
		assertEquals(0, sentEchoMatch(thread, echo))
	}

	@Test
	fun otherDeviceAppendsWhenNoOptimisticRow() {
		val thread = listOf(msg(fromMe = false, epoch = 5, seq = 11)) // an agent reply, not ours
		val echo = msg(fromMe = true, opId = "op-1", epoch = 5, seq = 12)
		assertEquals(-1, sentEchoMatch(thread, echo))
	}

	@Test
	fun reDrainFoldsByEpochAndSeq() {
		val thread = listOf(msg(fromMe = true, opId = "op-1", epoch = 5, seq = 12)) // already rendered
		val echo = msg(fromMe = true, opId = "op-1", epoch = 5, seq = 12)
		assertEquals(0, sentEchoMatch(thread, echo))
	}

	@Test
	fun duplicateEchoWithNewSeqFoldsOntoTheUpgradedRow() {
		// A reconcile re-send across a gateway restart can mint a second echo with the same opId
		// but a fresh seq; it must fold onto the already-upgraded row, not append a duplicate.
		val thread = listOf(msg(fromMe = true, opId = "op-1", epoch = 5, seq = 12, status = null))
		val echo = msg(fromMe = true, opId = "op-1", epoch = 5, seq = 20)
		assertEquals(0, sentEchoMatch(thread, echo))
	}

	@Test
	fun opIdDoesNotCrossMatchADifferentSend() {
		val thread = listOf(msg(fromMe = true, opId = "op-OTHER", status = "pending"))
		val echo = msg(fromMe = true, opId = "op-1", epoch = 5, seq = 12)
		assertEquals(-1, sentEchoMatch(thread, echo))
	}
}
