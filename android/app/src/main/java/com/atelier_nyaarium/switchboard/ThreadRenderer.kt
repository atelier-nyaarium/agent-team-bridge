package com.atelier_nyaarium.switchboard

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
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

/** The sender label for a row: `selfName` for our own row, the resolved human label for an
 * ordinary inbound row, or "from -> to" for a peer-mirror row. Neither peer-mirror party is this
 * console, so a bare `from` would render identically to a message actually addressed here - the
 * arrow is what tells the two apart. `resolve` stands in for `ThreadRenderer`'s own `resolveFrom`
 * callback so this stays pure/testable. */
internal fun renderedSender(m: Message, resolve: (String) -> String, selfName: String): String {
	if (m.fromMe) return selfName
	val fromLabel = m.from?.let(resolve) ?: ""
	if (!m.isPeer) return fromLabel
	val toLabel = m.to?.let(resolve) ?: return fromLabel
	return "$fromLabel → $toLabel"
}

/** Pure decoration data for one attachment chip: a display title shown instead of the filename,
 * and a short slug `kind` the web renderer maps to styling. Data only - a decorator never hands
 * the renderer markup or script. */
class ChipDecoration(
	val title: String,
	val kind: String,
	/** Drop the chip entirely rather than restyling it. For an attachment that is machinery the
	 * reader never chose to send, such as a reference snapshot: showing it as a file would invite a
	 * tap that opens a copy of source rather than the viewer the link already provides. */
	val hidden: Boolean = false,
)

/** The transcript payload the bundled web app receives (thread.js's setMessages/appendMessages).
 * `displayFrom` and `decorate` stand in for `ThreadRenderer`'s own callbacks so this stays
 * pure/testable, matching `renderedSender`. Decoration fields ride `JSONObject.put` like every
 * other field - never hand-concatenated - so string escaping through the eval-wrapped payload is
 * inherited automatically. */
internal fun messagesToJson(
	messages: List<Message>,
	displayFrom: (Message) -> String,
	playEnabled: Boolean,
	decorate: (MessageFile) -> ChipDecoration?,
): String {
	val arr = JSONArray()
	for (m in messages) {
		val obj = JSONObject()
			.put("id", m.id)
			.put("role", if (m.fromMe) "user" else "agent")
			.put("from", displayFrom(m))
			.put("at", m.at)
			.put("body", m.text)
		if (playEnabled && !m.fromMe) obj.put("canPlay", true)
		// Read-tracking flags (thread.js's pointer/region + arrival-suppression logic): `counts` is
		// pure row eligibility (inbound with real mailbox coordinates - never anchor-dependent, so
		// the client can filter a full setMessages payload locally without a shipped region list);
		// `ownSend` marks the moment-of-send row (fromMe with no coordinates yet), the only one that
		// should force-follow and clear-as-read on its own append (a settled echo from ANOTHER
		// device is fromMe too, but already carries coordinates, so it never sets this); a row
		// defaults `arrivedVisible` true (present only when explicitly false) since that is the
		// common case and the only one thread.js's suppression rule checks for.
		if (!m.fromMe && m.seq > 0L) obj.put("counts", true)
		if (m.fromMe && m.seq == 0L) obj.put("ownSend", true)
		if (!m.arrivedVisible) obj.put("arrivedVisible", false)
		m.status?.let { obj.put("status", it) }
		if (m.files.isNotEmpty()) {
			val files = JSONArray()
			for (f in m.files) {
				val fileObj = JSONObject().put("name", f.name).put("mime", f.mime).put("src", f.src)
				decorate(f)?.let { d ->
					fileObj.put(
						"decoration",
						JSONObject().put("title", d.title).put("kind", d.kind).put("hidden", d.hidden),
					)
				}
				files.put(fileObj)
			}
			obj.put("files", files)
		}
		arr.put(obj)
	}
	return arr.toString()
}

/**
 * One WebView running the bundled thread renderer (assets/thread/). Messages flow
 * one way via evaluateJavascript. Agent markdown is semi-trusted, so beyond the
 * renderer's own html-off + link allowlist, every resource load outside the
 * appassets origin is blocked at shouldInterceptRequest.
 *
 * The JS-to-Kotlin bridge carries only an opaque attachments-relative path; the
 * Kotlin side validates it stays inside the attachments directory and exposes no
 * filesystem listing or token surface.
 */
class ThreadRenderer(context: Context) {
	val webView: WebView = WebView(context)

	/** A crashed renderer leaves this WebView unusable; the owner must detach,
	 * destroy, and recreate it (onRenderProcessGone API contract). */
	var onRendererGone: (() -> Unit)? = null

	/** Set by the owner; called on the main thread with an attachments-relative
	 * path when the user taps an image or file chip. */
	var onOpenAttachment: ((String) -> Unit)? = null

	/** Set by the owner; called on the main thread with the row id of a failed
	 * send when the user taps its retry badge. */
	var onRetryMessage: ((Long) -> Unit)? = null

	/** Set by the owner; called with a failed row's id when Cancel is pressed, to lift that send
	 * back into the composer. */
	var onCancelMessage: ((Long) -> Unit)? = null

	/** Set by the owner; called on the main thread with a message `at` when the
	 * user taps an agent row's Play button. */
	var onPlayMessage: ((Long) -> Unit)? = null

	/** Set by the owner; called on the main thread with (row id, row `at`) when thread.js's scroll-
	 * driven pointer reports a new highest-read row. The `at` guards against a forget-freed id
	 * being reused by a later append before this debounced report lands. */
	var onReadUpTo: ((Long, Long) -> Unit)? = null

	/** A tapped link whose scheme a plugin claims, with the row it was tapped in. The row is not
	 * decoration: the same URL in two messages points at two different snapshots. */
	var onClaimedLinkTap: ((rowId: Long, rowAt: Long, url: String) -> Unit)? = null

	/** Set by the owner; receives the href of a tapped link. Scheme dispatch (http/https vs any
	 * custom protocol) is entirely the owner's job - this layer only reports the activation. */
	var onLinkTap: ((String) -> Unit)? = null

	/** Set by the owner; receives the href for the link context menu (open/copy). Raised two ways:
	 * a long-press on any standard anchor, or a plain tap on an inert "unhandled protocol" link
	 * (which has no href to navigate, so it arrives via the JS bridge instead of a hit test). */
	var onLinkMenu: ((String) -> Unit)? = null

	/** Set by the owner; maps a message's `from` canonical address to the session's human label at
	 * render time (so a notice shows "My Work" rather than the opaque address). Identity when unset. */
	var resolveFrom: ((String) -> String)? = null

	/** Set by the owner; the local user's own display name, read live at render time so a
	 * rename reflects without rebuilding the pool. Falls back to "you" when unset or blank. */
	var selfLabel: (() -> String)? = null

	/** Whether agent rows render a Play button. The owner sets it before sync
	 * (false when STTS is unprovisioned). */
	var playEnabled = false

	/** Set by the owner; returns decoration data for a file chip, or null for the plain chip.
	 * Consulted inside the serialization pass on the MAIN thread, once per file per sync - it must
	 * be a fast in-memory lookup, never disk or network. */
	var decorateFile: ((MessageFile) -> ChipDecoration?)? = null

	private var ready = false
	// Set once by destroy(); guards eval()/flushThenReveal against a callback (evaluateJavascript's
	// completion, or a debounced JS bridge call) that resolves after this WebView is torn down -
	// neither is a suspend call, so Compose leaving the composable cannot cancel them.
	private var destroyed = false
	private val pending = mutableListOf<String>()
	private var renderedCount = 0

	// Per-row content fingerprints of what is on screen, so an in-place change
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
				fun cancelMessage(id: String) {
					val msgId = id.toLongOrNull() ?: return
					webView.post { onCancelMessage?.invoke(msgId) }
				}

				@JavascriptInterface
				fun playMessage(at: String) {
					val msgAt = at.toLongOrNull() ?: return
					webView.post { onPlayMessage?.invoke(msgAt) }
				}

				@JavascriptInterface
				fun readUpTo(id: String, at: String) {
					val rowId = id.toLongOrNull() ?: return
					val rowAt = at.toLongOrNull() ?: return
					webView.post { onReadUpTo?.invoke(rowId, rowAt) }
				}

				@JavascriptInterface
				fun linkTap(id: String, at: String, url: String) {
					if (url.isEmpty()) return
					val rowId = id.toLongOrNull() ?: return
					val rowAt = at.toLongOrNull() ?: return
					webView.post { onClaimedLinkTap?.invoke(rowId, rowAt, url) }
				}

				// A tapped "unhandled protocol" link (inert, no href) - raises the same context
				// menu a long-press does, where Open renders greyed out.
				@JavascriptInterface
				fun linkMenu(url: String) {
					if (url.isEmpty()) return
					webView.post { onLinkMenu?.invoke(url) }
				}

				// A pure OS clipboard write - unlike the callbacks above, this needs no app-level
				// state or repo access, so it is handled entirely here rather than bubbling through
				// ThreadRendererPool. Android 13+ (this app's minSdk) shows its own copy
				// confirmation, so no local toast is needed.
				@JavascriptInterface
				fun copyToClipboard(text: String) {
					webView.post {
						val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
						cm.setPrimaryClip(ClipData.newPlainText("message", text))
					}
				}
			},
			"Android",
		)
		// Transparent so the page's own CSS background shows without a white flash
		// while the dark variant loads.
		webView.setBackgroundColor(Color.TRANSPARENT)

		// Long-press on a link raises the owner's open/copy menu; anywhere else keeps the
		// WebView default (text selection).
		webView.setOnLongClickListener {
			val hit = webView.hitTestResult
			val href = hit.extra
			if (hit.type == WebView.HitTestResult.SRC_ANCHOR_TYPE && !href.isNullOrEmpty()) {
				onLinkMenu?.invoke(href)
				true
			} else {
				false
			}
		}

		webView.webViewClient = object : WebViewClient() {
			override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
				return assetLoader.shouldInterceptRequest(request.url)
					?: WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
			}

			override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
				val url = request.url
				if (url.host == "appassets.androidplatform.net") return false
				onLinkTap?.invoke(url.toString())
				return true
			}

			override fun onPageFinished(view: WebView, url: String) {
				ready = true
				for (js in pending) view.evaluateJavascript(js, null)
				pending.clear()
			}

			override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
				// Returning true keeps the app alive. Recovery destroys this WebView,
				// which must not run re-entrantly inside this callback, so post it.
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
	 * keeps its scroll position and rendered DOM. A grown list appends the tail,
	 * rows whose content changed in place re-render by id, and a shrink replaces
	 * wholesale. `firstUnreadId` (the row to snap/hold at, null = bottom) is consulted only by the
	 * `setMessages` branch (a fresh render or a shrink rebuild) - `appendMessages` derives its own
	 * follow/hold decision from each row's `counts`/`ownSend`/`arrivedVisible` flags instead.
	 */
	fun sync(messages: List<Message>, firstUnreadId: Long?) {
		val prevRendered = renderedCount
		if (renderedCount == 0 || messages.size < renderedCount) {
			eval("window.thread.setMessages(${wrapForSetMessages(toJson(messages), firstUnreadId)})")
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

	private fun wrapForSetMessages(rowsJson: String, firstUnreadId: Long?): String =
		"""{"messages":$rowsJson,"firstUnreadId":${firstUnreadId ?: "null"}}"""

	/** Push the app foreground/background transition to this renderer. A background->foreground
	 * flip schedules one pointer walk (JS-side), covering content that shifted while invisible -
	 * ordered after any reveal already queued by the same resume, since both ride the same eval
	 * queue. Independent of sync payloads: firing regardless of whether messages changed is the
	 * point (a resume with no new arrivals still needs its walk re-armed). */
	fun setVisible(visible: Boolean) {
		eval("window.thread.setVisible($visible)")
	}

	/** Flush any pending debounced read receipt, THEN invoke `onFlushed` once its anchor update (if
	 * any) has landed on the Kotlin side - so a caller computing a reveal from `onFlushed` never
	 * snaps the reader above rows just reported read. Ordering rationale: `Android.readUpTo`'s
	 * bridge call happens SYNCHRONOUSLY within the flush JS's own execution (a JS thread blocks on
	 * a @JavascriptInterface call), so its `webView.post` is enqueued on main before this
	 * evaluateJavascript's own completion callback is - both are main-thread posts, delivered FIFO. */
	fun flushThenReveal(onFlushed: () -> Unit) {
		if (destroyed) return
		if (!ready) {
			onFlushed()
			return
		}
		webView.evaluateJavascript("window.thread.flushReadUpTo && window.thread.flushReadUpTo(); null") { _ ->
			if (!destroyed) onFlushed()
		}
	}

	/** Snap/hold at `firstUnreadId` (null = leave scroll position alone), shipping the current
	 * pointer region so thread.js's union-merge can adopt any id it does not already have queued.
	 * Called once per open, after [flushThenReveal]'s callback fires. */
	fun revealFirstUnread(firstUnreadId: Long?, regionIds: List<Long>) {
		val idArg = firstUnreadId?.toString() ?: "null"
		val idsJson = JSONArray(regionIds).toString()
		eval("window.thread.revealFirstUnread($idArg, $idsJson)")
	}

	private fun fingerprint(m: Message): Int {
		var h = m.text.hashCode()
		h = 31 * h + (m.status?.hashCode() ?: 0)
		h = 31 * h + m.files.size
		// The rendered sender is displayFrom(m), which changes on a rename (resolveFrom) or a
		// counterparty relabel (isPeer); include it so a re-sync re-pushes already-rendered rows
		// instead of leaving a stale sender label.
		h = 31 * h + displayFrom(m).hashCode()
		return h
	}

	private fun selfName(): String = selfLabel?.invoke()?.takeIf { it.isNotBlank() } ?: "you"

	private fun displayFrom(m: Message): String = renderedSender(m, { resolveFrom?.invoke(it) ?: it }, selfName())

	fun setDark(dark: Boolean) {
		eval("window.thread.setTheme($dark)")
	}

	/** Which URL schemes a plugin currently claims, so the renderer styles them as live links rather
	 * than as broken ones. Re-pushed on a plugin toggle; rows already rendered keep their old tier,
	 * the same accepted staleness as chip decoration. */
	fun setHandledSchemes(schemes: List<String>) {
		val list = schemes.joinToString(",") { JSONObject.quote(it) }
		eval("window.setHandledSchemes && window.setHandledSchemes([$list])")
	}

	/** Mirror whether the composer holds text, which is what gates Cancel on a failed row: only
	 * this side can see that box, and Cancel would otherwise overwrite what is being typed. */
	fun setComposerOccupied(occupied: Boolean) {
		eval("window.thread.setComposerOccupied($occupied)")
	}

	/** Swap the Play glyph on the row whose message is playing (null = none).
	 * Safe from any thread: playback state changes arrive from the player's
	 * daemon thread and evaluateJavascript must run on main. */
	fun setPlaying(at: Long?) {
		webView.post { eval("window.thread.setPlaying(${at ?: "null"})") }
	}

	fun destroy() {
		destroyed = true
		webView.destroy()
	}

	private fun eval(js: String) {
		if (destroyed) return
		if (ready) {
			webView.evaluateJavascript(js, null)
		} else {
			pending.add(js)
		}
	}

	private fun toJson(messages: List<Message>): String =
		messagesToJson(messages, ::displayFrom, playEnabled) { f -> decorateFile?.invoke(f) }
}
