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
	fun aTornFinalLineIsDroppedRatherThanFatal() {
		val dir = Files.createTempDirectory("journal").toFile()
		val journal = MutationJournal(dir)
		journal.append("intact", "send", JSONObject())
		val file = java.io.File(dir, "mutation-journal.jsonl")
		file.appendText("""{"opId":"torn","kind":"send","payl""")

		val reopened = MutationJournal(dir)

		assertEquals(listOf("intact"), reopened.pending().map { it.opId })
	}

	@Test
	fun interruptedRecoveryRewriteLeavesOriginalJournalIntact() {
		val dir = Files.createTempDirectory("journal").toFile()
		val journal = MutationJournal(dir)
		journal.append("first", "send", JSONObject())
		File(dir, "mutation-journal.jsonl").appendText("broken\n")
		journal.append("last", "send", JSONObject())

		var interrupted = false
		try {
			MutationJournal(dir, beforeJournalReplace = {
				interrupted = true
				throw IllegalStateException("interrupt")
			})
		} catch (_: MutationCommitException) {
		}

		assertTrue(interrupted)
		assertEquals(listOf("first", "last"), MutationJournal(dir).pending().map { it.opId })
	}

	@Test
	fun replayClaimIsOncePerProcess() {
		val dir = Files.createTempDirectory("journal").toFile()
		val journal = MutationJournal(dir)
		journal.append("op-1", "send", JSONObject())

		assertEquals(1, journal.claimForReplay().size)
		assertEquals(0, journal.claimForReplay().size)
	}

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

	@Test
	fun deletingARefusedScheduledRecordRemovesItsJournalEntry() {
		val dir = Files.createTempDirectory("journal-delete").toFile()
		val journal = MutationJournal(dir)
		journal.append("op-1", "scheduled_send", JSONObject())
		journal.transition("op-1", MutationState.REFUSED)
		journal.remove("op-1")
		journal.compact()

		assertTrue(MutationJournal(dir).entries("scheduled_send").isEmpty())
	}
}
