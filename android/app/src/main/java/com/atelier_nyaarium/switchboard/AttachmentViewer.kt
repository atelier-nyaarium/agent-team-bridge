package com.atelier_nyaarium.switchboard

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.provider.MediaStore
import android.widget.MediaController
import android.widget.Toast
import android.widget.VideoView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.io.File

////////////////////////////////
//  Interfaces & Types

/** A tapped attachment, resolved to its app-private file. */
data class OpenAttachment(
	val file: File,
	val name: String,
	val mime: String,
	val relPath: String,
)

////////////////////////////////
//  Functions & Helpers

fun mimeForFile(file: File): String {
	val ext = file.extension.lowercase()
	return android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
}

/** Decode bounded to a sane on-screen size; a hostile/huge image downsamples
 * instead of OOMing the viewer. */
private fun decodeBounded(file: File, maxDim: Int = 4096): Bitmap? = runCatching {
	val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
	BitmapFactory.decodeFile(file.path, bounds)
	if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
	var sample = 1
	while (bounds.outWidth / sample > maxDim || bounds.outHeight / sample > maxDim) sample *= 2
	BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
}.getOrNull()

/** Copy a file into the public Downloads collection via MediaStore (no runtime permission
 * needed). Shared by the attachment viewer and the Designer plugin's Download action. */
internal fun saveFileToDownloads(context: Context, file: File, name: String, mime: String): Boolean = runCatching {
	val resolver = context.contentResolver
	val values = ContentValues().apply {
		put(MediaStore.Downloads.DISPLAY_NAME, name)
		put(MediaStore.Downloads.MIME_TYPE, mime)
		put(MediaStore.Downloads.IS_PENDING, 1)
	}
	val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
	resolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } } ?: return false
	values.clear()
	values.put(MediaStore.Downloads.IS_PENDING, 0)
	resolver.update(uri, values, null, null)
	true
}.getOrDefault(false)

private fun saveToDownloads(context: Context, att: OpenAttachment): Boolean =
	saveFileToDownloads(context, att.file, att.name, att.mime)

private fun prettySize(bytes: Long): String = when {
	bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1_000_000.0)
	bytes >= 1_000 -> "%.0f KB".format(bytes / 1_000.0)
	else -> "$bytes B"
}

////////////////////////////////
//  Composables

/** Fullscreen viewer for images and videos; an info dialog for everything else.
 * Back dismisses (this BackHandler composes after App's, so it wins while shown). */
@Composable
fun AttachmentViewer(att: OpenAttachment, onOpenWith: () -> Unit, onDismiss: () -> Unit) {
	BackHandler(onBack = onDismiss)
	when {
		att.mime.startsWith("image/") -> FullscreenMedia(att, onOpenWith, onDismiss) { ZoomableImage(att.file) }
		att.mime.startsWith("video/") -> FullscreenMedia(att, onOpenWith, onDismiss) { VideoPlayer(att.file) }
		else -> FileInfoDialog(att, onOpenWith, onDismiss)
	}
}

@Composable
private fun FullscreenMedia(
	att: OpenAttachment,
	onOpenWith: () -> Unit,
	onDismiss: () -> Unit,
	content: @Composable () -> Unit,
) {
	val context = LocalContext.current
	Surface(Modifier.fillMaxSize(), color = Color.Black) {
		Column(Modifier.fillMaxSize()) {
			Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { content() }
			Row(
				Modifier.fillMaxWidth().background(Color(0xCC000000)).padding(horizontal = 8.dp, vertical = 2.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Text(
					att.name,
					color = Color.White,
					style = MaterialTheme.typography.labelMedium,
					fontFamily = FontFamily.Monospace,
					maxLines = 1,
					overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
					modifier = Modifier.weight(1f),
				)
				TextButton(onClick = hapticClick {
					val ok = saveToDownloads(context, att)
					Toast.makeText(context, if (ok) "Saved to Downloads" else "Save failed", Toast.LENGTH_SHORT).show()
				}) { Text("Save", color = Color.White) }
				TextButton(onClick = hapticClick(onOpenWith)) { Text("Open with", color = Color.White) }
				TextButton(onClick = hapticClick(onDismiss)) { Text("Close", color = Color.White) }
			}
		}
	}
}

@Composable
private fun ZoomableImage(file: File) {
	val bitmap = remember(file.path) { decodeBounded(file) }
	if (bitmap == null) {
		Text("Could not decode image", color = Color.White)
		return
	}
	var scale by remember { mutableFloatStateOf(1f) }
	var offsetX by remember { mutableFloatStateOf(0f) }
	var offsetY by remember { mutableFloatStateOf(0f) }
	Image(
		bitmap = bitmap.asImageBitmap(),
		contentDescription = file.name,
		modifier = Modifier
			.fillMaxSize()
			.pointerInput(Unit) {
				detectTransformGestures { _, pan, zoom, _ ->
					scale = (scale * zoom).coerceIn(1f, 6f)
					offsetX += pan.x
					offsetY += pan.y
				}
			}
			.graphicsLayer(scaleX = scale, scaleY = scale, translationX = offsetX, translationY = offsetY),
	)
}

@Composable
private fun VideoPlayer(file: File) {
	AndroidView(
		factory = { ctx ->
			VideoView(ctx).apply {
				setVideoPath(file.path)
				// Attach the controller only once prepared: by then the view is
				// attached and laid out, so the anchor is valid.
				setOnPreparedListener { mp ->
					mp.isLooping = false
					setMediaController(MediaController(ctx).also { it.setAnchorView(this) })
					start()
				}
			}
		},
		onRelease = { it.stopPlayback() },
		modifier = Modifier.fillMaxSize(),
	)
}

@Composable
private fun FileInfoDialog(att: OpenAttachment, onOpenWith: () -> Unit, onDismiss: () -> Unit) {
	val context = LocalContext.current
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(att.name, fontFamily = FontFamily.Monospace) },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
				Text(att.mime, style = MaterialTheme.typography.bodySmall)
				Text(prettySize(att.file.length()), style = MaterialTheme.typography.bodySmall)
			}
		},
		confirmButton = {
			Row {
				TextButton(onClick = hapticClick {
					val ok = saveToDownloads(context, att)
					Toast.makeText(context, if (ok) "Saved to Downloads" else "Save failed", Toast.LENGTH_SHORT).show()
					onDismiss()
				}) { Text("Save to Downloads") }
				TextButton(onClick = hapticClick(onOpenWith)) { Text("Open with...") }
			}
		},
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}
