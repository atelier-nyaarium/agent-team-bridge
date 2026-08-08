package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.RefFileMeta
import org.json.JSONObject

////////////////////////////////
//  Functions & Helpers

/** `optLong` reads a missing OR unparseable key as 0, turning "no value" into "0 B" and 1 Jan 1970.
 * Anything that is not a number reads as absent here instead, which a viewer hides. */
internal fun JSONObject.longOrNull(key: String): Long? = (opt(key) as? Number)?.toLong()

////////////////////////////////
//  Interfaces & Types

/**
 * A rendered attachment on a message. `src` is what the WebView loads (a data URI or an
 * appassets-proxied local path); a null `src` renders as a download chip. A null `size` or
 * `modifiedAt` means unknown, which a viewer hides rather than showing as zero.
 */
data class MessageFile(
	val name: String,
	val mime: String,
	val src: String? = null,
	val size: Long? = null,
	val modifiedAt: Long? = null,
	/** Names the bytes on the blob plane while they are still being fetched. A row with a blobId and
	 * no src is a file whose message has arrived and whose bytes have not, which is what lets a fetch
	 * resume across a restart instead of the attachment silently never appearing. */
	val blobId: String? = null,
	/** Which Gateway holds those bytes. Persisted with the reference because the fetch may not happen
	 * for hours, and by then nothing else remembers where the message came from. */
	val blobGateway: String? = null,
	/** What this file IS, declared by the sender. Null or "attachment" renders as an ordinary file;
	 * "ref-snapshot" hides as machinery; an unrecognized value shows demoted, because a wrong show
	 * heals at the next update while a wrong hide is unreachable. */
	val role: String? = null,
	/** Ref metadata for a "ref-snapshot" file, decoded from the wire's own generated shape. */
	val ref: RefFileMeta? = null,
	val cardTitle: String? = null,
	val cardGroup: String? = null,
	val cardWidth: Long? = null,
	val cardHeight: Long? = null,
)

////////////////////////////////
//  Functions & Helpers

/** Codec for the nested ref block: the codegen'd class through kotlinx, never a hand-built
 * JSONObject, so the wire shape and the stored shape cannot drift apart. */
private val fileMetaJson = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

/** The one shape every file-list writer shares, so a field added for one cannot go missing from another. */
internal fun fileJson(f: MessageFile): JSONObject =
	JSONObject()
		.put("name", f.name)
		.put("mime", f.mime)
		.putOpt("src", f.src)
		.putOpt("size", f.size)
		.putOpt("modifiedAt", f.modifiedAt)
		.putOpt("blobId", f.blobId)
		.putOpt("blobGateway", f.blobGateway)
		.putOpt("role", f.role)
		.putOpt("ref", f.ref?.let { fileMetaJson.encodeToString(RefFileMeta.serializer(), it) })
		.putOpt("cardTitle", f.cardTitle)
		.putOpt("cardGroup", f.cardGroup)
		.putOpt("cardWidth", f.cardWidth)
		.putOpt("cardHeight", f.cardHeight)

/** Read back a [fileJson] list from any record that carries one. */
internal fun loadFiles(m: JSONObject): List<MessageFile> {
	val arr = m.optJSONArray("files") ?: return emptyList()
	// Skip an unreadable element rather than throwing: the threads loader catches around its whole
	// key loop, so one bad entry there would cost every thread on the device instead of one row.
	return (0 until arr.length()).mapNotNull {
		val f = arr.optJSONObject(it) ?: return@mapNotNull null
		MessageFile(
			f.optString("name"),
			f.optString("mime"),
			f.optString("src").takeIf { s -> s.isNotEmpty() },
			f.longOrNull("size"),
			f.longOrNull("modifiedAt"),
			f.optString("blobId").takeIf { s -> s.isNotEmpty() },
			f.optString("blobGateway").takeIf { s -> s.isNotEmpty() },
			role = f.optString("role").takeIf { s -> s.isNotEmpty() },
			// A garbled blob reads as absent so the tap declines to the link menu, the documented
			// miss contract, instead of one bad row costing every thread.
			ref = f.optString("ref").takeIf { s -> s.isNotEmpty() }?.let { raw ->
				runCatching { fileMetaJson.decodeFromString(RefFileMeta.serializer(), raw) }.getOrNull()
			},
			cardTitle = f.optString("cardTitle").takeIf { s -> s.isNotEmpty() },
			cardGroup = f.optString("cardGroup").takeIf { s -> s.isNotEmpty() },
			cardWidth = f.longOrNull("cardWidth"),
			cardHeight = f.longOrNull("cardHeight"),
		)
	}
}
