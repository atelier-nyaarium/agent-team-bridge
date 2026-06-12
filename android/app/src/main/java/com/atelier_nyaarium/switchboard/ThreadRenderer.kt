package com.atelier_nyaarium.switchboard

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

private const val THREAD_URL = "https://appassets.androidplatform.net/assets/thread/thread.html"

/**
 * One WebView running the bundled thread renderer (assets/thread/). Messages flow
 * one way via evaluateJavascript. Agent markdown is semi-trusted, so beyond the
 * renderer's own html-off + link allowlist, every resource load outside the
 * appassets origin is blocked at shouldInterceptRequest (the callback that sees
 * subresources like img tags; shouldOverrideUrlLoading only sees navigations and
 * just routes link taps to the system browser).
 *
 * The one JS-to-Kotlin bridge (`Android.openAttachment`) carries only an opaque
 * attachments-relative path; the Kotlin side validates it stays inside the
 * attachments directory and exposes no filesystem listing or token surface.
 */
class ThreadRenderer(context: Context) {
	val webView: WebView = WebView(context)

	/** Set by the owner; a crashed renderer means this WebView is unusable and
	 * must be detached + destroyed, then recreated fresh (API contract of
	 * onRenderProcessGone). */
	var onRendererGone: (() -> Unit)? = null

	/** Set by the owner; called on the main thread with an attachments-relative
	 * path when the user taps an image or file chip. */
	var onOpenAttachment: ((String) -> Unit)? = null

	private var ready = false
	private val pending = mutableListOf<String>()
	private var renderedCount = 0

	init {
		configure(context)
	}

	@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
	private fun configure(context: Context) {
		// Serve bundled assets and decoded attachments through the asset loader so
		// the WebView loads them over https (file:// breaks module + fetch behavior).
		Attachments.root(context.filesDir).mkdirs()
		val assetLoader = WebViewAssetLoader.Builder()
			.addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
			.addPathHandler(
				"/${Attachments.DIR}/",
				WebViewAssetLoader.InternalStoragePathHandler(context, Attachments.root(context.filesDir)),
			)
			.build()

		webView.settings.javaScriptEnabled = true
		webView.settings.allowFileAccess = false
		webView.settings.allowContentAccess = false
		webView.addJavascriptInterface(
			object {
				@JavascriptInterface
				fun openAttachment(relPath: String) {
					webView.post { onOpenAttachment?.invoke(relPath) }
				}
			},
			"Android",
		)
		// Transparent so the page's own CSS background shows without a white flash
		// while the dark variant loads.
		webView.setBackgroundColor(Color.TRANSPARENT)

		webView.webViewClient = object : WebViewClient() {
			override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
				return assetLoader.shouldInterceptRequest(request.url)
					?: WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
			}

			override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
				val url = request.url
				if (url.host == "appassets.androidplatform.net") return false
				if (url.scheme == "http" || url.scheme == "https") {
					runCatching {
						view.context.startActivity(
							Intent(Intent.ACTION_VIEW, Uri.parse(url.toString()))
								.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
						)
					}
				}
				return true
			}

			override fun onPageFinished(view: WebView, url: String) {
				ready = true
				for (js in pending) view.evaluateJavascript(js, null)
				pending.clear()
			}

			override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
				// Returning true keeps the app alive, but this WebView is dead per
				// the API contract. Recovery (which destroys this WebView) must not
				// run re-entrantly inside this callback, so post it to the main loop.
				ready = false
				renderedCount = 0
				view.post { onRendererGone?.invoke() }
				return true
			}
		}

		webView.loadUrl(THREAD_URL)
	}

	/**
	 * Feed the current transcript, sending only what changed so re-opening a thread
	 * keeps its scroll position and rendered DOM. Threads are append-only, so a grown
	 * list appends the tail; anything else (first feed, shrink from clear/forget)
	 * replaces wholesale.
	 */
	fun sync(messages: List<Message>) {
		when {
			renderedCount == 0 || messages.size < renderedCount -> {
				eval("window.thread.setMessages(${toJson(messages)})")
			}
			messages.size > renderedCount -> {
				eval("window.thread.appendMessages(${toJson(messages.subList(renderedCount, messages.size))})")
			}
			else -> return
		}
		renderedCount = messages.size
	}

	fun setDark(dark: Boolean) {
		eval("window.thread.setTheme($dark)")
	}

	fun destroy() {
		webView.destroy()
	}

	private fun eval(js: String) {
		if (ready) {
			webView.evaluateJavascript(js, null)
		} else {
			pending.add(js)
		}
	}

	private fun toJson(messages: List<Message>): String {
		val arr = JSONArray()
		for (m in messages) {
			val obj = JSONObject()
				.put("id", m.id)
				.put("role", if (m.fromMe) "user" else "agent")
				.put("from", if (m.fromMe) "you" else "")
				.put("at", m.at)
				.put("body", m.text)
			if (m.files.isNotEmpty()) {
				val files = JSONArray()
				for (f in m.files) {
					files.put(JSONObject().put("name", f.name).put("mime", f.mime).put("src", f.src))
				}
				obj.put("files", files)
			}
			arr.put(obj)
		}
		return arr.toString()
	}
}
