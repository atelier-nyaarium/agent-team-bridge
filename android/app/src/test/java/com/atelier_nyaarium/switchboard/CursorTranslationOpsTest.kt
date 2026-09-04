package com.atelier_nyaarium.switchboard

import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonPrimitive
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CursorTranslationOpsTest {
	@Test
	fun mappedAnswerJournalsBeforeCommit() = runBlocking {
		val journal = MutationJournal(Files.createTempDirectory("translation").toFile())
		val coordinator = coordinator()
		val order = mutableListOf<String>()
		val ops = ops(coordinator, journal, buildJsonObject {
			put("translation", buildJsonObject {
				put("kind", "translated")
				put("cursor", buildJsonObject { put("epoch", 9L); put("seq", 4L) })
			})
		}, order, commit = { _, _, _ -> order += "commit"; true })

		ops.onWelcome(1L, 9L)

		assertEquals(listOf("journal", "commit"), order)
		assertEquals("cursor_translation", journal.entries("cursor_translation").single().kind)
	}

	@Test
	fun unmappedAnswerDoesNotCommitOrAckAndNamesEpoch() = runBlocking {
		val journal = MutationJournal(Files.createTempDirectory("translation").toFile())
		val coordinator = coordinator()
		var commits = 0
		var sends = 0
		val errors = mutableListOf<String>()
		val ops = ops(coordinator, journal, buildJsonObject {
			put("translation", buildJsonObject { put("kind", "unmapped") })
		}, mutableListOf(), sendCount = { sends++ }, commit = { _, _, _ -> commits++; true }, reportError = { errors += it })

		ops.onWelcome(1L, 9L)

		assertEquals(0, commits)
		assertEquals(1, sends)
		assertTrue(errors.single().contains("4"))
		assertTrue(journal.entries("cursor_translation").isEmpty())
	}

	@Test
	fun journaledTranslationReplaysWithoutSending() = runBlocking {
		val journal = MutationJournal(Files.createTempDirectory("translation").toFile())
		journal.append("translation", "cursor_translation", JSONObject()
			.put("migrationEpoch", 9L).put("fromEpoch", 4L).put("fromSeq", 3L).put("toEpoch", 9L).put("toSeq", 7L))
		val coordinator = coordinator()
		var sends = 0
		var committed = false
		val ops = ops(coordinator, journal, null, mutableListOf(), sendCount = { sends++ }, commit = { _, seq, epoch ->
			committed = seq == 7L && epoch == 9L
			true
		})

		ops.onWelcome(1L, 9L)

		assertEquals(0, sends)
		assertTrue(committed)
	}

	@Test
	fun processKillAfterJournalAppendReplaysTheSameCursorWithoutSending() = runBlocking {
		val dir = Files.createTempDirectory("translation-kill").toFile()
		val journal = MutationJournal(dir)
		val firstCoordinator = coordinator()
		val first = ops(firstCoordinator, journal, buildJsonObject {
			put("translation", buildJsonObject {
				put("kind", "translated")
				put("cursor", buildJsonObject { put("epoch", 9L); put("seq", 7L) })
			})
		}, mutableListOf(), commit = { _, _, _ -> error("process killed") })

		runCatching { first.onWelcome(1L, 9L) }
		assertEquals(1, journal.entries("cursor_translation").size)

		val secondJournal = MutationJournal(dir)
		val secondCoordinator = coordinator()
		var committed = false
		var sends = 0
		val second = ops(secondCoordinator, secondJournal, null, mutableListOf(), sendCount = { sends++ }, commit = { _, seq, epoch ->
			committed = seq == 7L && epoch == 9L
			true
		})

		second.onWelcome(1L, 9L)

		assertEquals(0, sends)
		assertTrue(committed)
	}

	@Test
	fun staleGenerationNeitherSendsNorCommits() = runBlocking {
		val journal = MutationJournal(Files.createTempDirectory("translation").toFile())
		val coordinator = coordinator()
		val stale = coordinator.beginSocket()
		coordinator.onWelcome(stale, 3L, 4L, 0L)
		val live = coordinator.beginSocket()
		coordinator.onWelcome(live, 3L, 4L, 0L)
		var sends = 0
		var commits = 0
		val ops = ops(coordinator, journal, null, mutableListOf(), sendCount = { sends++ }, commit = { _, _, _ -> commits++; true })

		ops.onWelcome(stale, 9L)

		assertEquals(0, sends)
		assertEquals(0, commits)
	}

	@Test
	fun consumerWelcomeBehindEpochTranslatesTheWelcomeCoordinate() = runBlocking {
		val journal = MutationJournal(Files.createTempDirectory("translation").toFile())
		val coordinator = coordinator()
		val sent = mutableListOf<JsonObject>()
		var committed = Triple(0L, 0L, 0L)
		val ops = ops(
			coordinator,
			journal,
			buildJsonObject {
				put("translation", buildJsonObject {
					put("kind", "translated")
					put("cursor", buildJsonObject { put("epoch", 9L); put("seq", 7L) })
				})
			},
			mutableListOf(),
			sent = sent,
			commit = { gen, seq, epoch -> committed = Triple(gen, seq, epoch); true },
		)

		ops.onWelcome(1L, 9L, welcomeCursor = 11L, welcomeEpoch = 4L)

		assertEquals(1, sent.size)
		assertEquals(4L, sent.single()["epoch"]!!.jsonPrimitive.content.toLong())
		assertEquals(11L, sent.single()["seq"]!!.jsonPrimitive.content.toLong())
		assertEquals(Triple(1L, 7L, 9L), committed)
	}

	private fun coordinator(): ConsoleTransportCoordinator = ConsoleTransportCoordinator(
		IdlePushbackManager(object : IdleSilenceStore {
			override fun loadIdleSilenceStart(): Long? = null
			override fun saveIdleSilenceStart(v: Long) = Unit
		}, 0L) { java.time.ZoneId.of("UTC") },
	).also {
		it.setMigrationEpoch(9L)
		val gen = it.beginSocket()
		it.onWelcome(gen, 3L, 4L, 0L)
	}

	private fun ops(
		coordinator: ConsoleTransportCoordinator,
		journal: MutationJournal,
		answer: JsonObject?,
		order: MutableList<String>,
		sendCount: () -> Unit = {},
		sent: MutableList<JsonObject> = mutableListOf(),
		commit: (Long, Long, Long) -> Boolean,
		reportError: (String) -> Unit = {},
	) = CursorTranslationOps(
		coordinator,
		journal,
		{ "owner:domain/owner" },
		{ 4L to 3L },
		{ op, _ -> sent += op; ownerOp() },
		{ sendCount(); answer },
		reportError,
		commit = { gen, seq, epoch ->
			assertEquals("cursor_translation", journal.entries("cursor_translation").singleOrNull()?.kind)
			order += "journal"
			commit(gen, seq, epoch)
		},
		ambient = testAmbient(opId = "cursor-translation-op"),
	)

	private fun ownerOp() = com.atelier_nyaarium.switchboard.proto.OwnerOp(
		1L, "domain", "signer", "conversation", "device", "op", 1L, "nonce", JsonObject(emptyMap()), "sig",
	)
}
