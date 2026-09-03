package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.scheduledBodyAadKind
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.ScheduledTarget
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SelfMigrationTest {
	private fun record(opId: String, createdAt: Long = 0L) =
		ScheduledSend("text", emptyList(), 100L, opId, null, createdAt)

	@Test
	fun migrationUploadsOldestFirstWithEachRecordsOwnOpId() = runBlocking {
		val sent = mutableListOf<Pair<String, String>>()
		migration(sent = { op -> sent += op.opId to op.op["opId"]!!.jsonPrimitive.content }).run(9L)

		assertEquals(listOf("old" to "old", "new" to "new"), sent)
	}

	@Test
	fun acceptedRecordStaysUntouchedAndSecondRunUploadsNothing() = runBlocking {
		val accepted = mutableSetOf("old")
		var sent = 0
		var cancelled = 0
		var tombstoned = 0
		val migration = migration(
			accepted = { accepted },
			sent = { op -> sent++; accepted += op.opId },
			cancel = { cancelled++ },
			tombstone = { tombstoned++ },
		)

		migration.run(9L)
		migration.run(9L)

		assertEquals(1, sent)
		assertEquals(1, cancelled)
		assertEquals(1, tombstoned)
	}

	@Test
	fun acceptedUploadCancelsAlarmAndTombstones() = runBlocking {
		var cancelled = 0
		var tombstoned = 0
		migration(answer = "accepted", cancel = { cancelled++ }, tombstone = { tombstoned++ }).run(9L)

		assertEquals(2, cancelled)
		assertEquals(2, tombstoned)
	}

	@Test
	fun refusedUploadKeepsAlarmAndRecord() = runBlocking {
		var cancelled = 0
		var tombstoned = 0
		migration(answer = "refused", cancel = { cancelled++ }, tombstone = { tombstoned++ }).run(9L)

		assertEquals(0, cancelled)
		assertEquals(0, tombstoned)
	}

	@Test
	fun refusedDispositionDoesNotBlockMarkerAndReportsOnce() = runBlocking {
		var sends = 0
		val errors = mutableListOf<String>()
		val migration = migration(records = mapOf("old" to record("old")), answer = "refused", sent = { sends++ }, reportError = { errors += it })

		migration.run(9L)
		migration.run(9L)

		assertEquals(1, sends)
		assertEquals(1, errors.size)
		assertTrue(errors.single().contains("old"))
		assertTrue(errors.single().contains("refused"))
	}

	@Test
	fun threeUnansweredAttemptsKeepOneJournalEntry() = runBlocking {
		val journal = MutationJournal(Files.createTempDirectory("unanswered").toFile())
		val migration = migration(records = mapOf("old" to record("old")), answer = "unanswered", journal = journal)

		migration.run(9L)
		migration.run(9L)
		migration.run(9L)

		assertEquals(1, journal.entries("scheduled_send").size)
	}

	@Test
	fun anAcceptedAnswerForARecordTheRouterAlreadyHoldsCountsAsAccepted() = runBlocking {
		var tombstoned = 0
		migration(answer = "accepted", tombstone = { tombstoned++ }).run(9L)

		assertEquals(2, tombstoned)
	}

	@Test
	fun migrationMarkerPreventsSecondRunForTheSameEpoch() = runBlocking {
		var sends = 0
		val migration = migration(sent = { sends++ })
		migration.run(9L)
		migration.run(9L)

		assertEquals(2, sends)
	}

	@Test
	fun aNewMigrationEpochRunsAgain() = runBlocking {
		var sends = 0
		val migration = migration(sent = { sends++ })
		migration.run(9L)
		migration.run(10L)

		assertEquals(4, sends)
	}

	@Test
	fun concurrentRunsUploadOnce() = runBlocking {
		var sends = 0
		val migration = migration(sendDelayMs = 10L, sent = { sends++ })

		listOf(launch { migration.run(9L) }, launch { migration.run(9L) }).joinAll()

		assertEquals(2, sends)
	}

	@Test
	fun scheduledBodyUsesTheScheduledAadKind() = runBlocking {
		var body: com.atelier_nyaarium.switchboard.proto.ContentEnvelope? = null
		val migration = migration(sent = { op ->
			val value = wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.ScheduleSendValue.serializer(), op.op)
			if (value.opId == "old") body = value.body
		})
		migration.run(9L)
		val ring = ContentKeyring().also { it.deriveOwned(identity, "domain", 2) }

		assertTrue(
			Crypto.openContent(body!!, ring.keyFor(2)!!, Crypto.ContentAad("domain", "owner", 2, scheduledBodyAadKind("conversation", "old"))).isNotEmpty(),
		)
	}

	@Test
	fun readAnchorsUploadAsReportReadForEveryLocalAnchor() = runBlocking {
		val reports = mutableListOf<String>()
		val migration = migration(
			records = emptyMap(),
			anchors = mapOf("a" to ReadAnchor(3L, 4L, 5L), "b" to ReadAnchor(6L, 7L, 8L)),
			report = { team, _ -> reports += team; acceptedAnswer() },
		)
		migration.run(9L)

		assertEquals(listOf("a", "b"), reports)
	}

	private val identity = Crypto.generateIdentity()

	private fun migration(
		records: Map<String, ScheduledSend> = mapOf("new" to record("new", 20L), "old" to record("old", 10L)),
		anchors: Map<String, ReadAnchor> = emptyMap(),
		answer: String = "accepted",
		accepted: () -> Set<String> = { emptySet() },
		sent: (OwnerOp) -> Unit = {},
		sendDelayMs: Long = 0L,
		cancel: (String) -> Unit = {},
		tombstone: (String) -> Unit = {},
		report: suspend (String, ReadAnchor) -> kotlinx.serialization.json.JsonElement? = { _, _ -> acceptedAnswer() },
		reportError: (String) -> Unit = {},
		journal: MutationJournal? = null,
	): SelfMigration {
		val ring = ContentKeyring().also { it.deriveOwned(identity, "domain", 2) }
		val actualJournal = journal ?: MutationJournal(Files.createTempDirectory("self-migration").toFile())
		return SelfMigration(
			records = { records }, readAnchors = { anchors }, journal = actualJournal,
			domainId = { "domain" }, ownerSignPub = { "owner" }, conversationId = { "conversation" },
			contentKeyring = { ring },
			target = { _, _ -> ScheduledTarget("domain", "gateway", "spawn.session") },
			uploadFile = { "sha256-" + "0".repeat(64) },
			sign = { op, opId -> ownerOp(op, opId) },
			send = { op ->
				if (sendDelayMs > 0L) delay(sendDelayMs)
				sent(op)
				if (op.op["kind"]?.jsonPrimitive?.content == "report_read") acceptedAnswer()
				else buildJsonObject { put("outcome", answer) }
			},
			acceptedUploads = accepted,
			reportRead = report,
			releaseLocal = { team, _ -> cancel(team); tombstone(team); true },
			reportError = reportError,
		)
	}

	private fun acceptedAnswer() = buildJsonObject { put("outcome", "accepted") }

	private fun ownerOp(op: JsonObject, opId: String) = OwnerOp(
		1L, "domain", "signer", "conversation", "device", opId, 1L, "nonce", op, "sig",
	)
}
