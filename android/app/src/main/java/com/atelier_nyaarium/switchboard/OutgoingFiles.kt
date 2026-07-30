package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File

////////////////////////////////
//  Interfaces & Types

/**
 * A file cleared to be sent. Construction is private, there is no byte field, and nothing here
 * hands out the contents, so "read a whole attachment into memory and hope it fits" is not an
 * expression this codebase can write on the send path. [OutgoingFiles.admit] is the only producer,
 * and it decides from a stat before anything proportional to the file is allocated.
 *
 * `source` is where the bytes live. The transport reads it a chunk at a time onto the blob plane
 * and sends a reference, so this handle is the only thing that is ever whole.
 */
class OutgoingFile private constructor(
	val name: String,
	val mime: String,
	val size: Long,
	internal val source: File,
) {
	internal companion object {
		fun of(name: String, mime: String, size: Long, source: File) = OutgoingFile(name, mime, size, source)
	}
}

/** Why a file was not cleared. A value rather than a null or a throw, so a caller cannot fall into
 * an accidental permit and cannot report the wrong reason to the user. */
sealed interface Admission {
	data class Granted(val file: OutgoingFile) : Admission

	data class Refused(val name: String, val reason: Reason, val size: Long, val budget: Long) : Admission

	enum class Reason {
		/** The local copy is gone, so there is nothing to send. */
		GONE,

		/** Larger than the wire will carry, on any device. */
		OVER_TRANSPORT,
	}
}

////////////////////////////////
//  Functions & Helpers

/**
 * The sole producer of [OutgoingFile].
 *
 * Admission stats; it never opens the file for reading, so the decision costs the same whatever the
 * file turns out to be.
 *
 * There is deliberately no heap check here any more. One used to refuse a large attachment on a
 * loaded device, because the send path held the file base64'd, JSON-encoded and sealed all at once,
 * at roughly 1.8x its size. The transport moves a bounded chunk at a time now, so the memory a send
 * costs no longer scales with the file, and a heap-proportional refusal would only deny work the
 * device can plainly do.
 */
object OutgoingFiles {
	/** Admit an already-local file (a bucket copy from a first send, or a scheduled send's). */
	fun admit(source: File, name: String, mime: String): Admission {
		if (!source.isFile) return Admission.Refused(name, Admission.Reason.GONE, 0, 0)
		return decide(name, mime, source.length(), source)
	}

	/**
	 * Admit a picked `content://` Uri by STREAMING it into [destination]. The copy is buffered, so
	 * the file never exists whole in memory even while being taken in.
	 */
	fun admit(resolver: ContentResolver, uri: Uri, destination: File): Admission {
		val name = displayName(resolver, uri) ?: "file"
		val mime = resolver.getType(uri) ?: "application/octet-stream"

		// Ask the provider first. A provider that will not answer gets refused rather than read
		// blind, since an unknown length is exactly the case that used to end in an OOM.
		val declared = runCatching {
			resolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
		}.getOrNull()
		if (declared == null || declared < 0) return Admission.Refused(name, Admission.Reason.GONE, 0, 0)
		(decide(name, mime, declared, destination) as? Admission.Refused)?.let { return it }

		val copied = runCatching {
			destination.parentFile?.mkdirs()
			resolver.openInputStream(uri)?.use { input -> destination.outputStream().use(input::copyTo) }
				?: return Admission.Refused(name, Admission.Reason.GONE, 0, 0)
			destination.length()
		}.getOrNull() ?: return Admission.Refused(name, Admission.Reason.GONE, 0, 0)

		// A provider may under-report; the bytes on disk are the truth, so re-decide on them.
		return decide(name, mime, copied, destination).also {
			if (it is Admission.Refused) destination.delete()
		}
	}

	/** Admit a whole list against ONE cumulative budget, so N files that each fit individually
	 * cannot together exceed what the transport or the heap will take. */
	fun admitAll(refs: List<MessageFile>, filesDir: File): List<Admission> {
		var running = 0L
		return refs.map { ref ->
			val source = Attachments.fileFor(filesDir, ref.src)
			if (source == null || !source.isFile) {
				return@map Admission.Refused(ref.name, Admission.Reason.GONE, 0, 0)
			}
			val size = source.length()
			running += size
			decide(ref.name, ref.mime, size, source, cumulative = running)
		}
	}

	private fun decide(
		name: String,
		mime: String,
		size: Long,
		source: File,
		cumulative: Long = size,
	): Admission {
		if (cumulative > ChatRepository.MAX_OUTGOING_BYTES) {
			return Admission.Refused(name, Admission.Reason.OVER_TRANSPORT, size, ChatRepository.MAX_OUTGOING_BYTES)
		}
		return Admission.Granted(OutgoingFile.of(name, mime, size, source))
	}

	private fun displayName(resolver: ContentResolver, uri: Uri): String? = runCatching {
		resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
			if (c.moveToFirst()) c.getString(0) else null
		}
	}.getOrNull()
}

/** The user-facing sentence for a refusal, so every surface says the same true thing. Notably NOT
 * "no longer on this device" for a size problem, which is what the old silent-drop path claimed. */
internal fun Admission.Refused.message(): String = when (reason) {
	Admission.Reason.GONE -> "\"$name\" is no longer on this device."
	Admission.Reason.OVER_TRANSPORT ->
		"\"$name\" is too large to send (max ${budget / 1_000_000} MB)."
}
