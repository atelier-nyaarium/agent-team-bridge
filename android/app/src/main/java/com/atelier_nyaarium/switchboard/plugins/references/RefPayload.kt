package com.atelier_nyaarium.switchboard.plugins.references

import java.io.File
import org.json.JSONArray
import org.json.JSONObject

////////////////////////////////
//  Functions & Helpers
//
//  The viewer's pure half: payload assembly with no Compose and no WebView, in its own file so the
//  unit suite loads it without dragging the UI facade's framework references along.

/** hljs language ids, by extension. An unknown extension renders as escaped plain text rather than
 * guessing, which is the same posture the thread renderer takes for an unlabelled fence. */
private val HLJS_LANGUAGE = mapOf(
	"ts" to "typescript", "mts" to "typescript", "cts" to "typescript", "tsx" to "typescript",
	"js" to "javascript", "mjs" to "javascript", "cjs" to "javascript", "jsx" to "javascript",
	"cpp" to "cpp", "cc" to "cpp", "cxx" to "cpp", "hpp" to "cpp", "hh" to "cpp", "h" to "cpp", "c" to "cpp",
	"cs" to "csharp", "py" to "python", "pyi" to "python", "gd" to "gdscript",
	"json" to "json", "md" to "markdown", "kt" to "kotlin", "sh" to "bash", "yml" to "yaml", "yaml" to "yaml",
	// The rest of what the vendored bundle already ships. Leaving one out costs nothing to add and
	// renders an ordinary source file as flat text.
	"go" to "go", "rs" to "rust", "java" to "java", "rb" to "ruby", "php" to "php", "sql" to "sql",
	"css" to "css", "scss" to "scss", "less" to "less", "lua" to "lua", "swift" to "swift", "r" to "r",
	"pl" to "perl", "m" to "objectivec", "ini" to "ini", "toml" to "ini", "diff" to "diff", "patch" to "diff",
	"xml" to "xml", "html" to "xml", "htm" to "xml", "svg" to "xml", "graphql" to "graphql", "makefile" to "makefile",
)

/** The banner text for a resolution that did not land exactly where the ref asked. */
internal fun noticeFor(key: com.atelier_nyaarium.switchboard.proto.RefKeyMeta): String? {
	val drift = when (key.quality) {
		"fuzzy" -> key.reason ?: "this reference no longer matches exactly"
		"unresolved" -> key.reason ?: "this reference could not be found in the file"
		else -> null
	}
	// Both fields are independently optional on the wire; an ambiguity claim without its count
	// (a partial legacy reconstruction) degrades to silence rather than printing a null.
	val ambiguity = if (key.ambiguous == true && key.matchCount != null) {
		"${key.matchCount} declarations matched; showing the first"
	} else {
		null
	}
	return listOfNotNull(drift, ambiguity).ifEmpty { null }?.joinToString(". ")
}

/** The payload the page renders. Built here rather than in JS so the viewer stays a renderer.
 *
 * The snapshot's content is its declared segments' text joined with newlines, so each segment's
 * text is recovered by consuming `lineCount` lines in order. A count past the end clamps: a lying
 * sender degrades its own render, never crashes the viewer. Absent (or empty) segments mean the
 * snapshot IS the whole file, numbered from 1. */
internal fun payloadFor(request: ReferenceOpenRequest, snapshot: File): String {
	val key = request.key
	val meta = request.meta

	val segments = JSONArray()
	val declared = meta.segments.orEmpty()
	if (declared.isEmpty()) {
		segments.put(JSONObject().put("startLine", 1).put("text", snapshot.readText()))
	} else {
		val lines = snapshot.readText().split("\n")
		var cursor = 0
		for (segment in declared) {
			val take = segment.lineCount.toInt().coerceIn(0, lines.size - cursor)
			segments.put(
				JSONObject()
					.put("startLine", segment.startLine)
					.put("text", lines.subList(cursor, cursor + take).joinToString("\n")),
			)
			cursor += take
		}
	}

	return JSONObject()
		.put("refPath", meta.refPath)
		.put("label", request.label)
		.put("language", HLJS_LANGUAGE[meta.refPath.substringAfterLast('.', "").lowercase()])
		.put("startLine", key.startLine)
		.put("endLine", key.endLine)
		.put("segments", segments)
		.apply {
			key.span?.let {
				put(
					"span",
					JSONObject()
						.put("startLine", it.startLine)
						.put("startColumn", it.startColumn)
						.put("endLine", it.endLine)
						.put("endColumn", it.endColumn),
				)
			}
			noticeFor(key)?.let { put("notice", it) }
		}
		.toString()
}
