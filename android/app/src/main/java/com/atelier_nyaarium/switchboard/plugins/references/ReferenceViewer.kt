package com.atelier_nyaarium.switchboard.plugins.references

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.atelier_nyaarium.switchboard.Attachments
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

////////////////////////////////
//  Functions & Helpers

/** hljs language ids, by extension. An unknown extension renders as escaped plain text rather than
 * guessing, which is the same posture the thread renderer takes for an unlabelled fence. */
private val HLJS_LANGUAGE = mapOf(
	"ts" to "typescript", "mts" to "typescript", "cts" to "typescript", "tsx" to "typescript",
	"js" to "javascript", "mjs" to "javascript", "cjs" to "javascript", "jsx" to "javascript",
	"cpp" to "cpp", "cc" to "cpp", "cxx" to "cpp", "hpp" to "cpp", "hh" to "cpp", "h" to "cpp", "c" to "cpp",
	"cs" to "csharp", "py" to "python", "pyi" to "python", "gd" to "gdscript",
	"json" to "json", "md" to "markdown", "kt" to "kotlin", "sh" to "bash", "yml" to "yaml", "yaml" to "yaml",
)

/** The banner text for a resolution that did not land exactly where the ref asked. */
internal fun noticeFor(entry: RefEntry): String? {
	val drift = when (entry.quality) {
		"fuzzy" -> entry.reason ?: "this reference no longer matches exactly"
		"unresolved" -> entry.reason ?: "this reference could not be found in the file"
		else -> null
	}
	val ambiguity = if (entry.ambiguous) "${entry.matchCount} declarations matched; showing the first" else null
	return listOfNotNull(drift, ambiguity).ifEmpty { null }?.joinToString(". ")
}

/** The payload the page renders. Built here rather than in JS so the viewer stays a renderer. */
internal fun payloadFor(request: ReferenceOpenRequest, snapshot: File): String {
	val entry = request.entry
	val file = request.file

	val segments = JSONArray()
	if (file.snippet && file.segments.isNotEmpty()) {
		for (segment in file.segments) {
			segments.put(JSONObject().put("startLine", segment.startLine).put("text", segment.text))
		}
	} else {
		segments.put(JSONObject().put("startLine", 1).put("text", snapshot.readText()))
	}

	return JSONObject()
		.put("refPath", file.refPath)
		.put("label", request.label)
		.put("language", HLJS_LANGUAGE[file.refPath.substringAfterLast('.', "").lowercase()])
		.put("startLine", entry.startLine)
		.put("endLine", entry.endLine)
		.put("segments", segments)
		.apply {
			entry.span?.let {
				put(
					"span",
					JSONObject()
						.put("startLine", it.startLine)
						.put("startColumn", it.startColumn)
						.put("endLine", it.endLine)
						.put("endColumn", it.endColumn),
				)
			}
			noticeFor(entry)?.let { put("notice", it) }
		}
		.toString()
}

////////////////////////////////
//  Composable

/**
 * The full-screen code viewer for one tapped ref.
 *
 * Same resource posture as the thread renderer: everything is a local asset, and any other request
 * is blocked outright, so a snapshot of an arbitrary project file can never cause a fetch.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ReferenceViewer(request: ReferenceOpenRequest, modifier: Modifier = Modifier) {
	val context = LocalContext.current
	val dark = !MaterialTheme.colorScheme.background.let { it.red + it.green + it.blue > 1.5f }
	val payload = remember(request) {
		Attachments.resolve(context.filesDir, request.rel)?.let { runCatching { payloadFor(request, it) }.getOrNull() }
	}

	Box(modifier.fillMaxSize()) {
		AndroidView(
			modifier = Modifier.fillMaxSize(),
			factory = { ctx ->
				WebView(ctx).apply {
					settings.javaScriptEnabled = true
					settings.allowFileAccess = false
					settings.allowContentAccess = false
					isVerticalScrollBarEnabled = true

					addJavascriptInterface(
						object {
							@JavascriptInterface
							fun ready() {
								post {
									evaluateJavascript("window.refview.setTheme($dark)", null)
									payload?.let { evaluateJavascript("window.refview.render($it)", null) }
								}
							}
						},
						"Android",
					)

					webViewClient = object : WebViewClient() {
						override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
							if (request.url.scheme == "file") null else WebResourceResponse("text/plain", "utf-8", null)

						override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
					}

					loadUrl("file:///android_asset/refview/refview.html")
				}
			},
		)
	}
}
