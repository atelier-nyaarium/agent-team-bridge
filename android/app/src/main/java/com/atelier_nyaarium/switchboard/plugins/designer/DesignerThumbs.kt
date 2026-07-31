package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.atelier_nyaarium.switchboard.ThumbCache
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

////////////////////////////////
//  Functions & Helpers

/** The offscreen viewport a card is laid out in before capture. Fixed (not the card's declared
 * meta size) so the invisible host never re-lays-out between renders; `loadWithOverviewMode` zooms
 * the card's own viewport to fit. 3:4, matching the gallery-row thumb slot. */
private const val CAPTURE_W = 480
private const val CAPTURE_H = 640

/** Captured bitmaps are downscaled by this before caching - a 240x320 ARGB thumb is ~300 KB. */
private const val THUMB_SCALE = 0.5f

/** How long one card may take from load to painted frame before the render is skipped. Static
 * no-JS HTML paints in tens of ms; this only trips on pathological content. */
private const val RENDER_TIMEOUT_MS = 4_000L

/**
 * Renders design cards to cached thumbnail bitmaps through ONE offscreen WebView, which
 * [DesignerThumbHost] keeps attached (invisibly) while the dock is composed - a WebView never
 * attached to any window renders blank, so the host, not this object, owns the view's lifecycle.
 * Renders serialize through a mutex (WebView is main-thread-only and there is one of it); the
 * cache is keyed by the card's `rel`, which a re-push replaces (new attachment bucket), so a stale
 * thumb for an updated canvas is structurally impossible.
 */
internal object DesignerThumbs {
	// The shared cache holds no lock, so this one covers captures only and an image decode never
	// queues behind a card render.
	private val renderLock = Mutex()
	private var webView: WebView? = null

	fun cached(rel: String?): Bitmap? = rel?.let { ThumbCache.get(ThumbCache.card(it)) }

	fun attach(wv: WebView) {
		webView = wv
	}

	fun detach(wv: WebView) {
		if (webView === wv) webView = null
	}

	/** The card's thumbnail, from cache or rendered now; null when the bytes have not landed, the
	 * file is gone/oversize, no host is attached, or the render timed out (the caller keeps its
	 * placeholder). */
	suspend fun render(filesDir: File, card: DesignerCard): Bitmap? {
		val rel = card.rel ?: return null
		val key = ThumbCache.card(rel)
		ThumbCache.get(key)?.let { return it }
		val html = withContext(Dispatchers.IO) { readCardHtml(filesDir, rel) } ?: return null
		return renderLock.withLock {
			ThumbCache.get(key)?.let { return it }
			val wv = webView ?: return null
			withTimeoutOrNull(RENDER_TIMEOUT_MS) { renderOn(wv, html) }?.also { ThumbCache.put(key, it) }
		}
	}

	private suspend fun renderOn(wv: WebView, html: String): Bitmap? = withContext(Dispatchers.Main) {
		// onPageFinished does NOT guarantee the frame is composited; postVisualStateCallback fires
		// only once this DOM state has actually rendered - the reliable capture signal.
		suspendCancellableCoroutine { cont ->
			wv.webViewClient = object : WebViewClient() {
				@Deprecated("Deprecated in Java")
				override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = true

				override fun onPageFinished(view: WebView, url: String?) {
					view.postVisualStateCallback(
						0,
						object : WebView.VisualStateCallback() {
							override fun onComplete(requestId: Long) {
								if (cont.isActive) cont.resume(Unit) { _, _, _ -> }
							}
						},
					)
				}
			}
			wv.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
		}
		if (!wv.isAttachedToWindow || wv.width == 0 || wv.height == 0) return@withContext null
		// Manual software draw into the scaled canvas - the standard WebView snapshot path (do NOT
		// setLayerType(LAYER_TYPE_SOFTWARE) app-wide; that deprecated mode is for on-screen display).
		val thumb = Bitmap.createBitmap(
			(wv.width * THUMB_SCALE).toInt(),
			(wv.height * THUMB_SCALE).toInt(),
			Bitmap.Config.ARGB_8888,
		)
		val canvas = Canvas(thumb)
		canvas.scale(THUMB_SCALE, THUMB_SCALE)
		wv.draw(canvas)
		thumb
	}
}

/** The render WebView: same static-only sandbox as the viewer's card surface (no JS, no network,
 * no file/content access, navigation swallowed), minus the zoom affordances a thumbnail never
 * needs. Overview mode fits the card's own viewport into the fixed capture size. */
private fun thumbWebView(ctx: Context): WebView = WebView(ctx).apply {
	settings.javaScriptEnabled = false
	settings.blockNetworkLoads = true
	settings.blockNetworkImage = true
	settings.allowFileAccess = false
	settings.allowContentAccess = false
	settings.useWideViewPort = true
	settings.loadWithOverviewMode = true
}

////////////////////////////////
//  Composables

/**
 * The invisible render host: keeps [DesignerThumbs]' WebView window-attached and laid out at the
 * capture size while the dock is composed, without occupying layout space or painting a pixel (the
 * zero-size clipped parent plus alpha 0). Captures happen via a manual `draw()` into a bitmap
 * canvas, so never being composited to screen is fine - only ATTACHMENT is load-bearing.
 */
@Composable
internal fun DesignerThumbHost() {
	val density = LocalDensity.current
	Box(Modifier.requiredSize(0.dp).clipToBounds()) {
		val captureSize = with(density) { Modifier.requiredSize(CAPTURE_W.toDp(), CAPTURE_H.toDp()) }
		AndroidView(
			factory = { ctx -> thumbWebView(ctx).also { DesignerThumbs.attach(it) } },
			onRelease = {
				DesignerThumbs.detach(it)
				it.destroy()
			},
			modifier = captureSize.alpha(0f),
		)
	}
}

/** A card's rendered thumbnail, cropped to fill [modifier]'s bounds; [placeholder] renders until
 * the thumb is ready (or forever, when the card's file is gone or the render failed). */
@Composable
internal fun CardThumb(
	filesDir: File,
	card: DesignerCard,
	modifier: Modifier,
	placeholder: @Composable () -> Unit,
) {
	var bmp by remember(card.rel) { mutableStateOf(DesignerThumbs.cached(card.rel)) }
	if (bmp == null) {
		LaunchedEffect(card.rel) { bmp = DesignerThumbs.render(filesDir, card) }
	}
	val ready = bmp
	if (ready != null) {
		Image(
			bitmap = ready.asImageBitmap(),
			contentDescription = null,
			modifier = modifier,
			contentScale = ContentScale.Crop,
		)
	} else {
		placeholder()
	}
}
