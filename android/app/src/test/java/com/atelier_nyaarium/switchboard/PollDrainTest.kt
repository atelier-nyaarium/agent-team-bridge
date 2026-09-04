package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.InboxRow
import com.atelier_nyaarium.switchboard.proto.OpKey
import com.atelier_nyaarium.switchboard.proto.PlaneRead
import com.atelier_nyaarium.switchboard.proto.RowEnvelope
import com.atelier_nyaarium.switchboard.proto.RowOrigin
import com.atelier_nyaarium.switchboard.proto.SyncAdvance
import com.atelier_nyaarium.switchboard.proto.SyncCursor
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class PollDrainTest {
	private class FakeHost(private val router: Map<String, PlaneRead>) : DrainHost {
		override val drainGate = DrainGate()
		override val state = MutableStateFlow(ChatState())
		override val isVisible = false
		override val autoGenerate = false
		val applied = mutableListOf<String>()
		val reads = mutableListOf<JsonObject>()
		var dispatched = 0
		override fun link() = ConsoleLink.POLL
		override fun plan(visible: Boolean, socket: Boolean, failed: Boolean): ConsoleTransportPlan = error("unused")
		override suspend fun restorePresence() = Unit
		override fun thisDeviceAddress() = null
		override fun fromCanonical(value: String) = value
		override fun advanceMailbox(result: SyncPollResult<Drained>): SyncAdvance<Drained> = error("unused")
		override fun setGap(value: Boolean) = Unit
		override fun markCommsActivity(now: Long) = Unit
		override fun reconcileSent(team: String, message: Message) = Unit
		override fun appendInbound(team: String, message: Message, beforeCommit: () -> Unit) = false
		override fun autoPlayTier(): SttsPlayer.Tier? = null
		override fun isSttsReady() = false
		override fun onInbound(team: String, messages: List<Message>) = Unit
		override fun preloadMessage(team: String, at: Long) = Unit
		override suspend fun enqueueForPlay(team: String, at: Long, tier: SttsPlayer.Tier) = Unit
		override fun commitMailbox(cursor: SyncCursor) = Unit
		override fun decodeAttachments(files: List<ChannelFile>?) = emptyList<MessageFile>()
		override fun fetchPendingAttachments() = Unit
		override suspend fun dispatchInboxRows(rows: List<InboxRow>) { dispatched += rows.size }
		override suspend fun applyPlane(name: String, payload: JsonElement?): Boolean {
			drainGate.withDrainMutex { applied += name }
			return true
		}
		override suspend fun poll(known: Map<String, Long>): TickOutcome = error("unused")
		override suspend fun readPlanes(held: JsonObject): List<PlaneRead> {
			reads += held
			return router.values.filter { it.version > (held[it.name]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L) }
		}
	}

	@Test
	fun nestedPlaneApplicationDoesNotBlockFollowingRows() = runBlocking {
		val host = FakeHost(emptyMap())
		val drain = PollDrain(host)
		val row = InboxRow(RowEnvelope(RowOrigin("owner", "domain"), OpKey("team", "op"), JsonPrimitive("clear"), "kind", emptyList()), "sig", JsonPrimitive("body"), 1L, 1L, 1L)
		drain.withDrainMutex {
			drain.applyPlane("presence", 1L, JsonPrimitive("payload"))
			host.dispatchInboxRows(listOf(row))
		}
		assertEquals(listOf("presence"), host.applied)
		assertEquals(1, host.dispatched)
	}

	@Test
	fun welcomeFetchesOnlyWhenItNamesANewerPlane() = runBlocking {
		val host = FakeHost(
			mapOf(
				"presence" to PlaneRead("presence", 2L, JsonPrimitive("roster")),
				"taskBoard" to PlaneRead("taskBoard", 1L, JsonPrimitive("board")),
			),
		)
		val drain = PollDrain(host)
		drain.applyWelcomePlanes(buildJsonObject { put("presence", 2L); put("taskBoard", 1L) })
		drain.applyWelcomePlanes(buildJsonObject { put("presence", 2L); put("taskBoard", 0L) })
		assertEquals(listOf(buildJsonObject {}), host.reads)
		assertEquals(listOf("presence", "taskBoard"), host.applied)
		assertEquals(buildJsonObject { put("presence", 2L); put("taskBoard", 1L) }, drain.knownPlanesJson())

		drain.applyWelcomePlanes(buildJsonObject { put("presence", 3L) })
		assertEquals(2, host.reads.size)
		assertEquals(listOf("presence", "taskBoard"), host.applied)

		drain.resetPlaneCursors()
		drain.applyWelcomePlanes(buildJsonObject { put("presence", 2L); put("taskBoard", 1L) })
		assertEquals(3, host.reads.size)
		assertEquals(listOf("presence", "taskBoard", "presence", "taskBoard"), host.applied)
	}
}
