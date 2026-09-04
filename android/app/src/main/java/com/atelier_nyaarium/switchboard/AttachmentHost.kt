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

/** Without a client the staged files are removed and the reason shown. */
internal fun AttachmentHost.rejectIfUnconnected(files: List<OutgoingFile>): Boolean {
	if (client != null) return false
	cleanup(files)
	report("Connect before adding attachments")
	return true
}

internal class ChatRepositoryAttachmentHost(private val repo: ChatRepository) : AttachmentHost {
	override val client: ConsoleClient? get() = repo.client
	override fun admit(uri: Uri, destination: File): Admission = OutgoingFiles.admit(repo.contentResolver, uri, destination)
	override fun cleanup(files: List<OutgoingFile>) = files.forEach { it.source.delete() }
	override fun report(message: String) { repo._state.update { it.copy(error = message) } }
}
