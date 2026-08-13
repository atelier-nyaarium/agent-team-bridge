package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.ui.graphics.FilterQuality
import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * The write side of the QR path (ML Kit scans, zxing core encodes). A pending-tenant
 * provisioning blob is ~2-3 KB, which overflows the higher error-correction levels, so the
 * encoder falls back from M to L exactly like the host-side `render-provisioning-qr.ts` does;
 * an overflow at L surfaces as null so the caller can fall back to Copy / Save-as-file.
 */
object QrImage {
	// One module of quiet zone is enough for a screen-displayed code (the scanner's own
	// margin handling does the rest); 0 keeps the dense payload's modules large on screen.
	private const val QUIET_ZONE = 1

	/** Encode `text` as a QR bitmap of `sizePx` (square), or null if even error-correction
	 * level L overflows (the payload is too large for a single QR - the caller offers Copy /
	 * Save-as-file instead). Tries M first (more scan-robust), then L (more capacity). */
	fun encode(text: String, sizePx: Int): Bitmap? {
		for (ec in listOf(ErrorCorrectionLevel.M, ErrorCorrectionLevel.L)) {
			val bmp = runCatching { encodeAt(text, sizePx, ec) }.getOrNull()
			if (bmp != null) return bmp
		}
		return null
	}

	private fun encodeAt(text: String, sizePx: Int, ec: ErrorCorrectionLevel): Bitmap {
		val hints = mapOf(
			EncodeHintType.ERROR_CORRECTION to ec,
			EncodeHintType.MARGIN to QUIET_ZONE,
			EncodeHintType.CHARACTER_SET to "UTF-8",
		)
		val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
		val w = matrix.width
		val h = matrix.height
		val pixels = IntArray(w * h)
		for (y in 0 until h) {
			val row = y * w
			for (x in 0 until w) {
				pixels[row + x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
			}
		}
		return Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { it.setPixels(pixels, 0, w, 0, 0, w, h) }
	}
}

/** Render `text` as a QR code filling the available width. Encoding happens off-recomposition
 * (remembered on the text), and an overflow renders the fallback slot instead. The bitmap is
 * drawn with no smoothing so the modules stay crisp at any scale. */
@Composable
fun QrCode(text: String, sizePx: Int = 1024, modifier: Modifier = Modifier, onOverflow: @Composable () -> Unit = {}) {
	val bitmap = remember(text, sizePx) { QrImage.encode(text, sizePx) }
	if (bitmap == null) {
		onOverflow()
		return
	}
	val image = remember(bitmap) { bitmap.asImageBitmap() }
	Image(
		painter = BitmapPainter(image, filterQuality = FilterQuality.None),
		contentDescription = "Setup QR code",
		contentScale = ContentScale.Fit,
		alignment = Alignment.Center,
		modifier = modifier.fillMaxWidth().aspectRatio(1f),
	)
}
