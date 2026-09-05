package com.atelier_nyaarium.switchboard

import android.net.Uri
import java.io.File
import kotlinx.coroutines.flow.update

internal interface AttachmentHost {
	val client: ConsoleClient?
	fun admit(uri: Uri, destination: File): Admission
	fun cleanup(files: List<OutgoingFile>)
	fun report(message: String)
}

/** One read of the client; without one the staged files are removed and the reason shown. */
internal fun AttachmentHost.clientOrReject(files: List<OutgoingFile>): ConsoleClient? {
	client?.let { return it }
	cleanup(files)
	report("Connect before adding attachments")
	return null
}

internal class ChatRepositoryAttachmentHost(private val repo: ChatRepository) : AttachmentHost {
	override val client: ConsoleClient? get() = repo.clientOrNull()
	override fun admit(uri: Uri, destination: File): Admission = OutgoingFiles.admit(repo.contentResolver, uri, destination)
	override fun cleanup(files: List<OutgoingFile>) = files.forEach { it.source.delete() }
	override fun report(message: String) { repo._state.update { it.copy(error = message) } }
}
