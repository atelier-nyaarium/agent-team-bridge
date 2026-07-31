package com.atelier_nyaarium.switchboard.plugins.references

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.atelier_nyaarium.switchboard.Attachments
import org.json.JSONObject

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
fun ReferenceViewer(request: ReferenceOpenRequest, modifier: Modifier = Modifier) = androidx.compose.runtime.key(request) {
	// key(request) owns the whole lifecycle: a request swap under a live viewer tears this subtree
	// down (releasing the WebView) and rebuilds it fresh, so the one-shot factory closure can never
	// render a previous ref's payload under the new request. produceState alone does NOT give this -
	// its backing state is remembered unkeyed, only its effect restarts.
	val context = LocalContext.current
	val dark = !MaterialTheme.colorScheme.background.let { it.red + it.green + it.blue > 1.5f }
	// Off the main thread: the payload build reads the whole snapshot file. The WebView composes
	// only once the read has SETTLED (Result present, its value possibly null for a gone snapshot),
	// so the factory always sees the final answer - never a race against a still-running read.
	val loaded by androidx.compose.runtime.produceState<Result<String?>?>(initialValue = null) {
		value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
			runCatching {
				Attachments.resolve(context.filesDir, request.rel)?.let { payloadFor(request, it) }
			}
		}
	}

	val settled = loaded
	// Branch rather than return early: a non-local return out of an inline lambda emits a marker
	// D8 cannot represent in dex, so the whole APK fails to build while the JVM tests stay green.
	if (settled == null) {
		Box(modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
			androidx.compose.material3.CircularProgressIndicator()
		}
	} else {
		// A read that THREW (an unreadable or oversize snapshot) is a different fact than a snapshot
		// that is simply gone, and the page says which.
		val payload = settled.getOrNull()
		val failureNote =
			if (settled.isFailure) "Couldn't open this snapshot." else "This snapshot is no longer available on this device."
		Box(modifier.fillMaxSize()) {
		AndroidView(
			modifier = Modifier.fillMaxSize(),
			// Each dismissal must take its renderer process with it; the sibling Designer WebViews do
			// the same. Without it, every ref tap in a session leaves one behind.
			onRelease = { it.destroy() },
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
									if (payload != null) {
									evaluateJavascript("window.refview.render($payload)", null)
								} else {
									// The tap was already claimed, so the link menu is unreachable. Say what
									// happened rather than leaving a blank page that reads as a dead tap.
									val note = JSONObject.quote(failureNote)
									evaluateJavascript("window.refview.unavailable($note)", null)
								}
								}
							}
						},
						"Android",
					)

					webViewClient = object : WebViewClient() {
						// A large snapshot builds tens of thousands of nodes, which is the shape that
						// OOMs a renderer. Returning true keeps the app alive instead of letting the
						// framework kill the process out from under the conversation.
						override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true

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
}
