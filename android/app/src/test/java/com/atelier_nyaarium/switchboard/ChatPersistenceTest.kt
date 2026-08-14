package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The codec for everything the console remembers across restarts. A codec defect does not throw,
 * it drops a field, so every case here asserts what SURVIVES a round trip or a poisoned slot.
 */
class ChatPersistenceTest {
	private class FakeStore : ChatPersistenceStore {
		val slots = mutableMapOf<String, String>()

		override fun saveThreads(json: String) {
			slots["threads"] = json
		}

		override fun loadThreads(): String? = slots["threads"]

		override fun saveReadAnchors(json: String) {
			slots["anchors"] = json
		}

		override fun loadReadAnchors(): String? = slots["anchors"]

		override fun saveThreadsAndReadAnchors(threadsJson: String, anchorsJson: String) {
			slots["threads"] = threadsJson
			slots["anchors"] = anchorsJson
		}

		override fun saveLabels(json: String) {
			slots["labels"] = json
		}

		override fun loadLabels(): String? = slots["labels"]

		override fun saveScheduledSends(json: String) {
			slots["scheduled"] = json
		}

		override fun loadScheduledSends(): String? = slots["scheduled"]

		override fun saveAbsenceStreaks(json: String) {
			slots["streaks"] = json
		}

		override fun loadAbsenceStreaks(): String? = slots["streaks"]

		override fun saveDrafts(json: String) {
			slots["drafts"] = json
		}

		override fun loadDrafts(): String? = slots["drafts"]

		override fun saveGoals(json: String) {
			slots["goals"] = json
		}

		override fun loadGoals(): String? = slots["goals"]
	}

	private val store = FakeStore()
	private val codec = ChatPersistence(store)
	private val team = "home.gw.app.dev"
	private val peerTeam = "home.gw.lib.dev"

	private fun message(
		at: Long,
		fromMe: Boolean = false,
		text: String = "hello",
		status: String? = null,
		opId: String? = null,
		epoch: Long = 7L,
		seq: Long = at,
	) = Message(fromMe, text, at, 0L, emptyList(), status, opId, epoch = epoch, seq = seq)

	////////////////////////////////
	//  Threads

	@Test
	fun aThreadRoundTripsWithItsCoordinatesAndDenseIdsByTime() {
		val rows = listOf(message(at = 30), message(at = 10, fromMe = true, text = "mine"), message(at = 20))
		codec.persistThreads(mapOf(team to rows))
		val loaded = codec.loadPersistedThreads().getValue(team)

		assertEquals(listOf("mine", "hello", "hello"), loaded.map { it.text })
		assertEquals(listOf(10L, 20L, 30L), loaded.map { it.at })
		assertEquals(listOf(0L, 1L, 2L), loaded.map { it.id })
		assertEquals(7L, loaded.first().epoch)
		assertEquals(10L, loaded.first().seq)
	}

	@Test
	fun aWakingRowIsDroppedAndALegacyPendingEchoDemotesToRetriable() {
		codec.persistThreads(
			mapOf(
				team to listOf(
					message(at = 1, status = "waking"),
					message(at = 2, fromMe = true, status = "pending", opId = null),
					message(at = 3, fromMe = true, status = "pending", opId = "op-1"),
				),
			),
		)
		val loaded = codec.loadPersistedThreads().getValue(team)

		assertEquals(listOf(2L, 3L), loaded.map { it.at })
		assertEquals("error", loaded[0].status)
		assertEquals("pending", loaded[1].status)
	}

	@Test
	fun aNonAddressKeyIsDroppedOnLoadAndForGoodOnTheNextSave() {
		codec.persistThreads(mapOf(team to listOf(message(at = 1)), "Pixel 10 Pro XL" to listOf(message(at = 2))))
		val loaded = codec.loadPersistedThreads()

		assertEquals(setOf(team), loaded.keys)
		codec.persistThreads(loaded)
		assertTrue(!store.slots.getValue("threads").contains("Pixel"))
	}

	@Test
	fun aMalformedPeerAttributionDegradesInsteadOfSurfacingVerbatim() {
		val peer = Message(false, "hi", 5L, 0L, emptyList(), null, null, from = peerTeam, to = team, isPeer = true)
		codec.persistThreads(mapOf(team to listOf(peer)))
		// Corrupt the persisted from-address into a non-canonical value.
		store.slots["threads"] = store.slots.getValue("threads").replace(peerTeam, "not an address")
		val loaded = codec.loadPersistedThreads().getValue(team).single()

		assertTrue(loaded.isPeer)
		assertTrue(loaded.from != "not an address")
	}

	@Test
	fun aTornThreadsSlotDegradesToEmptyRatherThanThrowing() {
		store.slots["threads"] = "{ this is not json"
		assertEquals(emptyMap<String, List<Message>>(), codec.loadPersistedThreads())
	}

	@Test
	fun oneBrokenThreadEntryBlanksTheWholeLoad() {
		// The threads loader contains per FILE, not per row: a structurally broken sibling costs the
		// whole map, and the empty result is what keeps a half-trusted transcript from rendering.
		store.slots["threads"] = """{"$team":[{"me":false,"text":"good","at":1}],"$peerTeam":"not-an-array"}"""
		assertEquals(emptyMap<String, List<Message>>(), codec.loadPersistedThreads())
	}

	////////////////////////////////
	//  Read anchors

	@Test
	fun theFirstRunSeedsEveryExistingThreadAtItsOwnTailAndPersistsTheSeed() {
		val threads = mapOf(
			team to listOf(message(at = 1), message(at = 9, seq = 9L), message(at = 12, fromMe = true)),
			peerTeam to listOf(message(at = 3, fromMe = true)),
		)
		val seeded = codec.loadPersistedReadAnchors(threads)

		// The tail is the last row that counts unread; a thread with none gets no seed.
		assertEquals(ReadAnchor(7L, 9L, 9L), seeded.getValue(team))
		assertNull(seeded[peerTeam])
		// Persisted, so the next load answers from the store and a fresh team stays unseeded.
		assertEquals(seeded, codec.loadPersistedReadAnchors(emptyMap()))
	}

	@Test
	fun persistedAnchorsWinOverTheSeedPath() {
		codec.persistReadAnchors(mapOf(team to ReadAnchor(1L, 2L, 3L)))
		val loaded = codec.loadPersistedReadAnchors(mapOf(peerTeam to listOf(message(at = 8))))

		assertEquals(mapOf(team to ReadAnchor(1L, 2L, 3L)), loaded)
	}

	@Test
	fun aLegitimatelyEmptyAnchorMapNeverReseeds() {
		// Only a NULL slot means first run; an empty persisted map is an answer, and reseeding over
		// it would resurrect every old message as unread.
		store.slots["anchors"] = "{}"
		assertEquals(emptyMap<String, ReadAnchor>(), codec.loadPersistedReadAnchors(mapOf(team to listOf(message(at = 8)))))
	}

	@Test
	fun anAnchorUnderANonAddressKeyIsDropped() {
		store.slots["anchors"] = """{"$team":{"epoch":1,"seq":2,"at":3},"Pixel 10 Pro XL":{"epoch":9,"seq":9,"at":9}}"""
		assertEquals(mapOf(team to ReadAnchor(1L, 2L, 3L)), codec.loadPersistedReadAnchors(emptyMap()))
	}

	////////////////////////////////
	//  Labels and absence streaks

	@Test
	fun labelsRoundTripAndDropNonAddressKeys() {
		codec.persistLabels(mapOf(team to "Reviewer", "not-an-address" to "ghost"))
		assertEquals(mapOf(team to "Reviewer"), codec.loadPersistedLabels())
	}

	@Test
	fun onePoisonedLabelBlanksTheWholeMap() {
		// Whole-file containment, like threads: labels are cheap to relearn from the wire.
		store.slots["labels"] = """{"$team":"Reviewer","$peerTeam":7}"""
		assertEquals(emptyMap<String, String>(), codec.loadPersistedLabels())
	}

	@Test
	fun absenceStreaksRoundTripAndDropNonAddressKeys() {
		codec.persistAbsenceStreaks(mapOf(team to 4, "Pixel 10 Pro XL" to 9))
		assertEquals(mapOf(team to 4), codec.loadPersistedAbsenceStreaks())
	}

	////////////////////////////////
	//  Scheduled sends

	@Test
	fun aPoisonedScheduledRowCostsItselfAloneNeverItsSiblings() {
		val good = ScheduledSend(
			text = "later",
			fileRefs = emptyList(),
			fireAtMillis = 99L,
			opId = "op-9",
			targetDomainId = null,
			createdAt = 1L,
		)
		codec.persistScheduledSends(mapOf(team to good))
		// Splice a non-object sibling row into the persisted JSON.
		store.slots["scheduled"] = store.slots.getValue("scheduled").removeSuffix("}") + ",\"$peerTeam\":42}"
		val loaded = codec.loadPersistedScheduledSends()

		assertEquals(setOf(team), loaded.keys)
		assertEquals("later", loaded.getValue(team).text)
	}

	@Test
	fun aScheduledSendUnderANonAddressKeyIsDropped() {
		store.slots["scheduled"] =
			"""{"Pixel 10 Pro XL":{"text":"x","files":[],"fireAt":99,"opId":"op-1","createdAt":1}}"""
		assertEquals(emptyMap<String, ScheduledSend>(), codec.loadPersistedScheduledSends())
	}

	@Test
	fun aRecordThatWouldFireImmediatelyIsDroppedInsteadOfRisked() {
		val blankOp = ScheduledSend(
			text = "a",
			fileRefs = emptyList(),
			fireAtMillis = 99L,
			opId = "",
			targetDomainId = null,
			createdAt = 1L,
		)
		val zeroFire = ScheduledSend(
			text = "b",
			fileRefs = emptyList(),
			fireAtMillis = 0L,
			opId = "op-1",
			targetDomainId = null,
			createdAt = 1L,
		)
		codec.persistScheduledSends(mapOf(team to blankOp, peerTeam to zeroFire))

		assertEquals(emptyMap<String, ScheduledSend>(), codec.loadPersistedScheduledSends())
	}

	////////////////////////////////
	//  Goals

	@Test
	fun aGoalKeepsBothWaitInstantsAcrossARestart() {
		val awaitingReply = PendingGoal(text = "Complete the plan", armedAt = 10L, sentAt = 11L)
		val awaitingIdle = PendingGoal(text = "Ship it", armedAt = 20L, sentAt = 21L, replyAt = 22L)
		codec.persistGoals(mapOf(team to awaitingReply, peerTeam to awaitingIdle))
		val loaded = codec.loadPersistedGoals()

		// An absent instant must come back absent, not as a zero that reads as long ago.
		assertEquals(mapOf(team to awaitingReply, peerTeam to awaitingIdle), loaded)
		assertNull(loaded.getValue(team).replyAt)
	}

	@Test
	fun aGoalThatCouldNeverFireOrTimeOutIsDropped() {
		val noText = PendingGoal(text = "", armedAt = 10L)
		val noClock = PendingGoal(text = "Complete the plan", armedAt = 0L)
		codec.persistGoals(mapOf(team to noText, peerTeam to noClock))

		// Nothing to type, and no clock to time out against.
		assertEquals(emptyMap<String, PendingGoal>(), codec.loadPersistedGoals())
	}

	@Test
	fun oneUnreadableGoalRowDoesNotTakeTheOthersWithIt() {
		codec.persistGoals(mapOf(team to PendingGoal(text = "Complete the plan", armedAt = 10L, sentAt = 11L)))
		store.slots["goals"] = store.slots.getValue("goals").removeSuffix("}") + ",\"$peerTeam\":42}"
		val loaded = codec.loadPersistedGoals()

		assertEquals(setOf(team), loaded.keys)
		assertEquals("Complete the plan", loaded.getValue(team).text)
	}

	////////////////////////////////
	//  Drafts

	@Test
	fun aLegacyBareStringDraftLoadsBesideACurrentShapeOne() {
		store.slots["drafts"] =
			"""{"$team":"typed on the old app","$peerTeam":{"text":"current","files":[]},"home.gw.x":{"text":"short key"}}"""
		val loaded = codec.loadPersistedDrafts()

		// The two shapes coexist in one file; an empty legacy row and a non-canonical key drop.
		assertEquals(
			mapOf(team to Draft(text = "typed on the old app"), peerTeam to Draft(text = "current")),
			loaded,
		)
	}

	@Test
	fun aDraftRoundTripsItsFilesAndLocationsAndDropsBlankLocations() {
		val file = MessageFile(src = "draft/a.png", name = "a.png", mime = "image/png", size = 5L)
		val draft = Draft(text = "note", files = listOf(file), locations = mapOf("draft/a.png" to "Downloads"))
		codec.persistDrafts(mapOf(team to draft))
		// A blank location must hide rather than show a guess.
		store.slots["drafts"] = store.slots.getValue("drafts").replace("Downloads", "")
		val loaded = codec.loadPersistedDrafts().getValue(team)

		assertEquals("note", loaded.text)
		assertEquals(listOf("draft/a.png"), loaded.files.map { it.src })
		assertEquals(emptyMap<String, String>(), loaded.locations)
	}

	@Test
	fun aPoisonedDraftRowCostsItselfAloneNeverItsSiblings() {
		store.slots["drafts"] = """{"$team":{"text":"kept","files":[]},"$peerTeam":12}"""
		// A numeric row is neither shape; the sibling survives.
		assertEquals(mapOf(team to Draft(text = "kept")), codec.loadPersistedDrafts())
	}
}
