package com.atelier_nyaarium.switchboard

import android.net.Uri
import java.io.File
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScheduledSendOpsTest {
	private class FakeOps : ScheduledSendOpsCollaborators {
		val appended = mutableListOf<Message>()
		val delivered = mutableListOf<String>()
		override fun admitPicked(uris: List<Uri>, bucket: String) = emptyList<OutgoingFile>() to null
		override fun canonicalTarget(team: String) = team
		override fun scheduleAttachmentDelete(srcs: List<String>) = Unit
		override fun takeBackIntoDraft(team: String, text: String, files: List<MessageFile>) = Unit
		override fun append(team: String, message: Message): Long { appended += message; return 9L }
		override fun rebuildFiles(files: List<MessageFile>) = emptyList<OutgoingFile>() to null
		override suspend fun deliver(team: String, echoId: Long, text: String, files: List<OutgoingFile>, opId: String, targetDomainId: String?) { delivered += text }
		override suspend fun retrySend(team: String, messageId: Long, targetDomainId: String?) = Unit
	}

	@Test
	fun dueRecordEchoesDeliversAndClears() = runBlocking {
		val store = testStore()
		val state = MutableStateFlow(ChatState())
		val fake = FakeOps()
		val rec = ScheduledSend("later", emptyList(), System.currentTimeMillis() - 1L, "op", null, 1L)
		state.value = ChatState(scheduledSends = mapOf("local.gw.host.session" to rec))
		val pushback = IdlePushbackManager(object : IdleSilenceStore {
			override fun loadIdleSilenceStart(): Long? = null
			override fun saveIdleSilenceStart(v: Long) = Unit
		}, 0L) { ZoneId.of("UTC") }
		val ops = ScheduledSendOps(state, ChatPersistence(store), File("/tmp/switchboard-scheduled"), CoroutineScope(Dispatchers.Unconfined), MutationJournal(File("/tmp/switchboard-scheduled")), TestIdentityPort(store), pushback, { true }, fake)

		assertTrue(ops.fireDueScheduledSends().isEmpty())
		assertTrue(ops.fireDueScheduledSends().isEmpty())

		assertEquals("later", fake.appended.single().text)
		assertEquals("op", fake.appended.single().opId)
		assertEquals(listOf("later"), fake.delivered)
		assertEquals(emptyMap<String, ScheduledSend>(), state.value.scheduledSends)
	}
}
