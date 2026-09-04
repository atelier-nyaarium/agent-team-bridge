package com.atelier_nyaarium.switchboard

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AttachmentHostTest {
	@Test
	fun pickingWithoutAClientReportsAndCleansUp() {
		val host = FakeAttachmentHost()
		val file = OutgoingFile.of("pick.txt", "text/plain", 1, File("/tmp/pick.txt"))

		assertNull(host.clientOrReject(listOf(file)))
		assertEquals(listOf(file), host.cleaned)
		assertEquals("Connect before adding attachments", host.message)
	}

	private class FakeAttachmentHost : AttachmentHost {
		override val client: ConsoleClient? = null
		var cleaned = emptyList<OutgoingFile>()
		var message: String? = null

		override fun admit(uri: android.net.Uri, destination: File): Admission = error("unused")
		override fun cleanup(files: List<OutgoingFile>) {
			cleaned = files
		}
		override fun report(message: String) {
			this.message = message
		}
	}
}
