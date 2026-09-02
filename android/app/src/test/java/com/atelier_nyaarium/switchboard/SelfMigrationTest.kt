package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SelfMigrationTest {
	private fun record(opId: String, createdAt: Long = 0L) =
		ScheduledSend("text", emptyList(), 100L, opId, null, createdAt)

	// Releasing on anything but acceptance loses the send whenever the Router did not take it. The
	// worst case has to be a send that fires locally, never one that never fires.
	@Test
	fun releasesTheLocalRecordOnlyWhenTheRouterAcceptedIt() {
		assertTrue(releasesLocal(UploadOutcome.ACCEPTED))
		assertFalse(releasesLocal(UploadOutcome.UNANSWERED))
		assertFalse(releasesLocal(UploadOutcome.REFUSED))
	}

	// A fresh id per attempt would make each retry its own operation, so a record uploaded twice
	// would land twice.
	@Test
	fun uploadsUnderTheRecordsOwnIdRatherThanAFreshOne() {
		val rec = record("op-1")

		assertEquals("op-1", migrationOpId(rec))
		assertEquals(migrationOpId(rec), migrationOpId(rec))
	}

	@Test
	fun skipsWhatTheRouterAlreadyAccepted() {
		val records = mapOf("a" to record("op-1"), "b" to record("op-2"))

		assertEquals(listOf("b"), pendingUploads(records, setOf("op-1")).map { it.first })
	}

	@Test
	fun uploadsOldestFirst() {
		val records = mapOf("new" to record("op-2", 200L), "old" to record("op-1", 100L))

		assertEquals(listOf("old", "new"), pendingUploads(records, emptySet()).map { it.first })
	}

	@Test
	fun uploadsNothingOnceEveryRecordIsAccepted() {
		val records = mapOf("a" to record("op-1"))

		assertTrue(pendingUploads(records, setOf("op-1")).isEmpty())
	}
}
