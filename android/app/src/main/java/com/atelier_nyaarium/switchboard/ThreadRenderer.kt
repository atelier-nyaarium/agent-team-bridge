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

	/** Set by the owner; called on the main thread with the row id of a failed
	 * send when the user taps its retry badge. */
	var onRetryMessage: ((Long) -> Unit)? = null

	/** Set by the owner; called on the main thread with a message `at` when the
	 * user taps an agent row's Play button. */
	var onPlayMessage: ((Long) -> Unit)? = null

	/** Whether agent rows render a Play button. The owner sets it before sync
	 * (false when STTS is unprovisioned). */
	var playEnabled = false

	private var ready = false
	private val pending = mutableListOf<String>()
	private var renderedCount = 0

	// Per-row content fingerprints of what is on screen, so an in-place change
	// (echo pending -> sent/error, waking placeholder resolving into the reply)
	// re-renders just that row via the id-replace path in appendMessages.
	private var fingerprints = mapOf<Long, Int>()

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

				@JavascriptInterface
				fun retryMessage(id: String) {
					val msgId = id.toLongOrNull() ?: return
					webView.post { onRetryMessage?.invoke(msgId) }
				}

				@JavascriptInterface
				fun playMessage(at: String) {
					val msgAt = at.toLongOrNull() ?: return
					webView.post { onPlayMessage?.invoke(msgAt) }
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
	 * keeps its scroll position and rendered DOM. Threads are append-mostly: a grown
	 * list appends the tail, rows whose content changed in place (send states, the
	 * waking placeholder resolving) re-render by id, and a shrink (clear/forget)
	 * replaces wholesale.
	 */
	fun sync(messages: List<Message>) {
		val prevRendered = renderedCount
		if (renderedCount == 0 || messages.size < renderedCount) {
			eval("window.thread.setMessages(${toJson(messages)})")
			renderedCount = messages.size
			fingerprints = messages.associate { it.id to fingerprint(it) }
			return
		}
		if (messages.size > renderedCount) {
			eval("window.thread.appendMessages(${toJson(messages.subList(renderedCount, messages.size))})")
			renderedCount = messages.size
		}
		val changed = messages.subList(0, prevRendered).filter { fingerprints[it.id] != fingerprint(it) }
		if (changed.isNotEmpty()) {
			eval("window.thread.appendMessages(${toJson(changed)})")
		}
		fingerprints = messages.associate { it.id to fingerprint(it) }
	}

	private fun fingerprint(m: Message): Int {
		var h = m.text.hashCode()
		h = 31 * h + (m.status?.hashCode() ?: 0)
		h = 31 * h + m.files.size
		return h
	}

	fun setDark(dark: Boolean) {
		eval("window.thread.setTheme($dark)")
	}

	/** Swap the Play glyph on the row whose message is playing (null = none).
	 * Safe from any thread: playback state changes arrive from the player's
	 * daemon thread and evaluateJavascript must run on main. */
	fun setPlaying(at: Long?) {
		webView.post { eval("window.thread.setPlaying(${at ?: "null"})") }
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
			if (playEnabled && !m.fromMe) obj.put("canPlay", true)
			m.status?.let { obj.put("status", it) }
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
