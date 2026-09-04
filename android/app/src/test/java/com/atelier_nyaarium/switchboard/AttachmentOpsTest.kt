package com.atelier_nyaarium.switchboard

import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Test

class AttachmentOpsTest {
	@Test
	fun orphanSweepRemovesUnreferencedBuckets() = runBlocking {
		val root = File.createTempFile("switchboard", "attachments").apply { delete(); mkdirs() }
		val bucket = File(Attachments.root(root), "blob-orphan").apply { mkdirs() }
		File(bucket, "bytes").writeText("orphan")
		bucket.setLastModified(System.currentTimeMillis() - Attachments.ORPHAN_SWEEP_MIN_AGE_MS - 1L)
		val store = testStore()
		val ops = AttachmentOps(
			MutableStateFlow(ChatState()),
			ChatPersistence(store),
			FailingClientPort,
			TestIdentityPort(store),
			root,
			{ null },
			object : AttachmentOpsCollaborators {
				override fun clientOrNull(): ConsoleClient? = null
				override suspend fun routerBlobRange(domainId: String, blobId: String, offset: Long, originGateway: String?) = null
				override fun attachmentBuckets() = emptySet<String>()
			},
		)

		ops.sweepOrphanAttachments()

		assertFalse(bucket.exists())
	}
}
