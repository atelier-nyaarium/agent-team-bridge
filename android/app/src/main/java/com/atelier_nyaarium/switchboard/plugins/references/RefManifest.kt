package com.atelier_nyaarium.switchboard.plugins.references

import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.MessageFile
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

////////////////////////////////
//  Interfaces & Types

/** One contiguous piece of a file, in ORIGINAL-file coordinates. */
data class RefSegment(val startLine: Int, val text: String)

data class RefFileEntry(
	val refPath: String,
	/** The name the file actually landed under on this device. */
	val filename: String,
	val snippet: Boolean,
	val segments: List<RefSegment>,
	val totalLines: Int,
)

/** A character span to highlight inside the range, in original-file coordinates. */
data class RefSpan(val startLine: Int, val startColumn: Int, val endLine: Int, val endColumn: Int)

data class RefEntry(
	val refPath: String,
	val startLine: Int,
	val endLine: Int,
	val span: RefSpan?,
	val quality: String,
	val reason: String?,
	val ambiguous: Boolean,
	val matchCount: Int,
)

data class RefManifest(val files: List<RefFileEntry>, val refs: Map<String, RefEntry>)

////////////////////////////////
//  Functions & Helpers

const val MANIFEST_FILENAME = "switchboard-references.json"

private const val MANIFEST_MARKER = "switchboardReferences"

/** A manifest describes a handful of snapshots, so anything this size is not one. Bounds the
 * tap-time read, which happens on the UI thread. */
private const val MAX_MANIFEST_BYTES = 512 * 1024

private val json = Json { ignoreUnknownKeys = true }

private fun relOf(src: String): String = src.substringAfter("attachments/", src)

/**
 * The manifest a row carries, or null.
 *
 * Selection is deliberately narrow: the FIRST file bearing the reserved name that also parses and
 * carries its self-describing marker. Content alone can never promote a foreign file, because a
 * crafted attachment cannot take the reserved name (the builder refuses that at compose time) and a
 * later file bearing the marker is never reached. A manifest naming a snapshot absent from this same
 * row is rejected wholesale rather than partly trusted.
 */
fun manifestFrom(filesDir: File, files: List<MessageFile>): RefManifest? {
	val present = files.mapNotNull { it.src?.let(::relOf) }.toSet()

	for (file in files) {
		if (file.name != MANIFEST_FILENAME) continue
		val rel = file.src?.let(::relOf) ?: continue
		val onDisk = Attachments.resolve(filesDir, rel) ?: continue
		if (onDisk.length() > MAX_MANIFEST_BYTES) continue

		val parsed = runCatching { json.parseToJsonElement(onDisk.readText()).jsonObject }.getOrNull() ?: continue
		if (parsed[MANIFEST_MARKER] == null) continue

		val manifest = runCatching { decode(parsed) }.getOrNull() ?: continue
		// Every snapshot it names must be on this row. A manifest pointing anywhere else is not
		// describing this message, so none of it is trusted.
		val named = manifest.files.map { entry -> files.firstOrNull { it.name == entry.filename }?.src?.let(::relOf) }
		if (named.any { it == null || it !in present }) continue

		return manifest
	}
	return null
}

private fun decode(root: JsonObject): RefManifest {
	val files = root["files"]!!.jsonArray.map { element ->
		val o = element.jsonObject
		RefFileEntry(
			refPath = o["refPath"]!!.jsonPrimitive.content,
			filename = o["filename"]!!.jsonPrimitive.content,
			snippet = o["mode"]?.jsonPrimitive?.content == "snippet",
			segments = o["segments"]?.jsonArray.orEmpty().map { s ->
				RefSegment(
					startLine = s.jsonObject["startLine"]!!.jsonPrimitive.intOrNull ?: 1,
					text = s.jsonObject["text"]!!.jsonPrimitive.content,
				)
			},
			totalLines = o["totalLines"]?.jsonPrimitive?.intOrNull ?: 0,
		)
	}

	val refs = root["refs"]!!.jsonObject.mapValues { (_, element) ->
		val o = element.jsonObject
		RefEntry(
			refPath = o["refPath"]!!.jsonPrimitive.content,
			startLine = o["startLine"]!!.jsonPrimitive.intOrNull ?: 1,
			endLine = o["endLine"]!!.jsonPrimitive.intOrNull ?: 1,
			span = o["span"]?.jsonObject?.let {
				RefSpan(
					startLine = it["startLine"]!!.jsonPrimitive.intOrNull ?: 1,
					startColumn = it["startColumn"]!!.jsonPrimitive.intOrNull ?: 0,
					endLine = it["endLine"]!!.jsonPrimitive.intOrNull ?: 1,
					endColumn = it["endColumn"]!!.jsonPrimitive.intOrNull ?: 0,
				)
			},
			quality = o["quality"]?.jsonPrimitive?.content ?: "exact",
            reason = o["reason"]?.jsonPrimitive?.content,
			ambiguous = o["ambiguous"]?.jsonPrimitive?.booleanOrNull ?: false,
			matchCount = o["matchCount"]?.jsonPrimitive?.intOrNull ?: 1,
		)
	}

	return RefManifest(files, refs)
}
