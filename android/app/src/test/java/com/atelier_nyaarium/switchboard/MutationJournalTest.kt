package com.atelier_nyaarium.switchboard

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MutationJournalTest {
	@Test
	fun pendingEntrySurvivesReopen() {
		val dir = Files.createTempDirectory("journal").toFile()
		MutationJournal(dir).append("op-1", "send", JSONObject().put("text", "hello"), 7L)
		val reopened = MutationJournal(dir)

		assertEquals("op-1", reopened.pending().single().opId)
		assertEquals("hello", reopened.pending().single().payload.getString("text"))
	}

	@Test
	fun commitFailureReachesCaller() {
		val notDirectory = Files.createTempFile("journal", ".tmp").toFile()
		val journal = MutationJournal(notDirectory)

		var thrown = false
		try {
			journal.append("op-1", "send", JSONObject())
		} catch (_: MutationCommitException) {
			thrown = true
		}
		assertTrue(thrown)
	}

	@Test
	fun replayClaimIsOncePerProcess() {
		val dir = Files.createTempDirectory("journal").toFile()
		val journal = MutationJournal(dir)
		journal.append("op-1", "send", JSONObject())

		assertEquals(1, journal.claimForReplay().size)
		assertEquals(0, journal.claimForReplay().size)
	}

	// A write sent before the process died has an unknown outcome, and the opId makes re-sending it
	// either a no-op or the recorded result. Leaving it settled would drop it silently.
	@Test
	fun aNewProcessReclaimsAWriteLeftInFlight() {
		val dir = Files.createTempDirectory("journal").toFile()
		val journal = MutationJournal(dir)
		journal.append("op-1", "send", JSONObject())
		journal.claimForReplay()

		assertEquals(listOf("op-1"), MutationJournal(dir).claimForReplay().map { it.opId })
	}

	@Test
	fun aSettledWriteIsNotReclaimed() {
		val dir = Files.createTempDirectory("journal").toFile()
		val journal = MutationJournal(dir)
		journal.append("op-1", "send", JSONObject())
		journal.transition("op-1", MutationState.ACKED)

		assertEquals(0, MutationJournal(dir).claimForReplay().size)
	}

	@Test
	fun compactionRemovesTerminalEntriesAndKeepsPending() {
		val dir = Files.createTempDirectory("journal").toFile()
		val journal = MutationJournal(dir)
		journal.append("pending", "send", JSONObject())
		journal.append("acked", "send", JSONObject())
		journal.transition("acked", MutationState.ACKED)
		journal.compact()

		val reopened = MutationJournal(dir)
		assertEquals(listOf("pending"), reopened.pending().map { it.opId })
		assertTrue(File(dir, "mutation-journal.jsonl").readText().contains("pending"))
		assertTrue(!File(dir, "mutation-journal.jsonl").readText().contains("acked"))
	}
}
