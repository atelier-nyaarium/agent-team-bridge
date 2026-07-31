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
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.FitScreen
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.io.File
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

////////////////////////////////
//  Interfaces & Types

/**
 * A tapped attachment, resolved to its app-private file.
 *
 * `size` and `modifiedAt` are the SENDER's, carried on the wire. The local copy's own mtime is when
 * the fetch wrote it, which is not the age the sender meant, so it is never substituted here. Both
 * are absent when nothing was stamped, and the matching row hides rather than guessing.
 */
data class OpenAttachment(
	val file: File,
	val name: String,
	val mime: String,
	val relPath: String,
	val size: Long? = null,
	val modifiedAt: Long? = null,
	/** Where a picked file came from. Draft-only: a sent attachment has no such thing, because it
	 * never crossed the wire and could not have. */
	val location: String? = null,
)

////////////////////////////////
//  Functions & Helpers

fun mimeForFile(file: File): String {
	val ext = file.extension.lowercase()
	return android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
}

/** A decoded bitmap with the facts the stage needs to talk about it: how far it was downsampled,
 * and how big the file actually is. Both are computed by the bounds pass and would otherwise be
 * thrown away, forcing a third file open to recover them. */
data class DecodedImage(val bitmap: Bitmap, val bounds: ImageBounds)

/** Decode bounded to a sane on-screen size; a hostile/huge image downsamples
 * instead of OOMing the viewer. */
private fun decodeBounded(file: File, maxDim: Int = 4096): DecodedImage? = runCatching {
	val probe = BitmapFactory.Options().apply { inJustDecodeBounds = true }
	BitmapFactory.decodeFile(file.path, probe)
	if (probe.outWidth <= 0 || probe.outHeight <= 0) return@runCatching null
	var sample = 1
	while (probe.outWidth / sample > maxDim || probe.outHeight / sample > maxDim) sample *= 2
	val bitmap = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
		?: return@runCatching null
	DecodedImage(
		bitmap,
		ImageBounds(
			width = bitmap.width,
			height = bitmap.height,
			sampleSize = sample,
			sourceWidth = probe.outWidth,
			sourceHeight = probe.outHeight,
		),
	)
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

////////////////////////////////
//  Composables

/** Fullscreen viewer for decodable images and videos; an info dialog for everything else.
 * Back dismisses (this BackHandler composes after App's, so it wins while shown). */
@Composable
fun AttachmentViewer(att: OpenAttachment, onOpenWith: () -> Unit, onDismiss: () -> Unit) {
	BackHandler(onBack = onDismiss)
	when {
		// The classifier decides, not an `image/` prefix: a prefix sends SVG and TIFF to
		// BitmapFactory, which cannot decode either, so the tap dead-ends on an error where a
		// readable file sheet belongs.
		viewerDecodableImage(att.mime) -> {
			val zoom = remember(att.file.path) { ZoomState() }
			FullscreenMedia(att, onOpenWith, onDismiss, bounds = zoom.bounds, controls = { ZoomPresets(zoom) }) {
				ZoomableImage(att.file, zoom)
			}
		}
		att.mime.startsWith("video/") -> FullscreenMedia(att, onOpenWith, onDismiss) { VideoPlayer(att.file) }
		else -> FullscreenMedia(att, onOpenWith, onDismiss) { FileStage(att) }
	}
}

/** True-pixel presets plus reset-to-fit. Momentary taps with no lit state: the buttons request a
 * scale, they do not represent one, so nothing here reflects the current zoom back at the user. */
@Composable
private fun ZoomPresets(zoom: ZoomState) {
	Row(
		Modifier.fillMaxWidth().padding(horizontal = 8.dp),
		horizontalArrangement = Arrangement.Center,
		verticalAlignment = Alignment.CenterVertically,
	) {
		TextButton(onClick = hapticClick { zoom.toRatio(ZoomMath.PRESET_HALF) }) { Text("50%", color = Color.White) }
		TextButton(onClick = hapticClick { zoom.toRatio(ZoomMath.PRESET_ACTUAL) }) { Text("100%", color = Color.White) }
		TextButton(onClick = hapticClick { zoom.toRatio(ZoomMath.PRESET_DOUBLE) }) { Text("200%", color = Color.White) }
		IconButton(onClick = hapticClick { zoom.toFit() }) {
			Icon(Icons.Filled.FitScreen, contentDescription = "Fit to screen", tint = Color.White)
		}
	}
}

@Composable
private fun FullscreenMedia(
	att: OpenAttachment,
	onOpenWith: () -> Unit,
	onDismiss: () -> Unit,
	bounds: ImageBounds? = null,
	controls: (@Composable () -> Unit)? = null,
	content: @Composable () -> Unit,
) {
	val context = LocalContext.current
	val repo = remember(context) { Repo.get(context) }
	val scope = rememberCoroutineScope()
	var storedTree by remember { mutableStateOf(repo.saveTreeUri) }
	// Resolved off the main thread and only when the folder changes. Validating a grant queries the
	// document provider over IPC, and doing that inline would run it on every recomposition, which
	// during a zoom gesture is every frame.
	val folder by produceState<String?>(null, storedTree) {
		value = withContext(Dispatchers.IO) { SaveTarget.label(context, storedTree) }
	}

	// Whether the pick now in flight owes a write when it returns. OpenDocumentTree carries no caller
	// state, and the picker is opened for two opposite reasons: to finish a save whose folder turned
	// out to be dead, and to change where future saves go. Without this, choosing a folder from the
	// Change button would write a file the user never asked to save.
	var saveAfterPick by remember { mutableStateOf(false) }

	fun forgetFolder() {
		repo.saveTreeUri = ""
		storedTree = ""
	}

	val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { tree ->
		val owesWrite = saveAfterPick
		saveAfterPick = false
		if (tree == null) return@rememberLauncherForActivityResult
		scope.launch {
			val taken = withContext(Dispatchers.IO) { SaveTarget.persist(context, tree) }
			if (!taken) {
				Toast.makeText(context, "Could not keep access to that folder", Toast.LENGTH_SHORT).show()
				return@launch
			}
			repo.saveTreeUri = tree.toString()
			storedTree = tree.toString()
			if (!owesWrite) return@launch
			val result = withContext(Dispatchers.IO) {
				SaveTarget.writeToTree(context, tree, att.file, att.name, att.mime) to
					SaveTarget.label(context, tree.toString())
			}
			val message = if (result.first == SaveOutcome.Ok) "Saved to ${result.second ?: "folder"}" else "Save failed"
			Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
		}
	}

	/** Hand the user back to the picker to finish a save whose destination turned out to be dead. */
	fun repickToFinishSave() {
		forgetFolder()
		Toast.makeText(context, "That folder is no longer available", Toast.LENGTH_SHORT).show()
		saveAfterPick = true
		pickFolder.launch(null)
	}

	val save = {
		scope.launch {
			val current = storedTree
			val tree = withContext(Dispatchers.IO) { SaveTarget.writableTree(context, current) }
			when {
				// No folder chosen yet, so there is no grant to use. Downloads needs none, which is
				// the whole reason the first save cannot go through SAF.
				tree == null && current.isBlank() -> {
					val ok = withContext(Dispatchers.IO) { saveToDownloads(context, att) }
					Toast.makeText(context, if (ok) "Saved to Downloads" else "Save failed", Toast.LENGTH_SHORT)
						.show()
				}
				tree == null -> repickToFinishSave()
				else -> {
					val outcome = withContext(Dispatchers.IO) {
						SaveTarget.writeToTree(context, tree, att.file, att.name, att.mime)
					}
					when (outcome) {
						SaveOutcome.Ok ->
							Toast.makeText(context, "Saved to ${folder ?: "folder"}", Toast.LENGTH_SHORT).show()
						SaveOutcome.FolderGone -> repickToFinishSave()
						// The folder is fine, so re-picking would not help and would only cost the
						// setting to fix something the setting was not causing.
						SaveOutcome.WriteFailed ->
							Toast.makeText(context, "Save failed", Toast.LENGTH_SHORT).show()
					}
				}
			}
		}
	}

	Surface(Modifier.fillMaxSize(), color = Color.Black) {
		Column(Modifier.fillMaxSize()) {
			Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { content() }
			// The app sets no window insets anywhere, so without this the bottom row sits under the
			// gesture-nav pill and its buttons swallow the swipe.
			Column(Modifier.fillMaxWidth().background(Color(0xCC000000)).navigationBarsPadding()) {
				InfoRows(att, bounds)
				SaveLocationRow(folder) { pickFolder.launch(null) }
				controls?.invoke()
				Row(
					Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
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
					TextButton(onClick = hapticClick { save() }) { Text("Save", color = Color.White) }
					TextButton(onClick = hapticClick(onOpenWith)) { Text("Open with", color = Color.White) }
					TextButton(onClick = hapticClick(onDismiss)) { Text("Close", color = Color.White) }
				}
			}
		}
	}
}

/** The stage's live zoom. Hoisted out of the image so the preset row below it can drive the same
 * scale the gesture does; a preset cannot be computed without the frame the image was measured in. */
private class ZoomState {
	var scale by mutableFloatStateOf(ZoomMath.FIT)
	var offsetX by mutableFloatStateOf(0f)
	var offsetY by mutableFloatStateOf(0f)
	var bounds by mutableStateOf<ImageBounds?>(null)
	var containerWidth by mutableIntStateOf(0)
	var containerHeight by mutableIntStateOf(0)

	val ready: Boolean
		get() = bounds != null && containerWidth > 0 && containerHeight > 0

	/** Jump to a true-pixel ratio, anchored on the frame centre. The offset resets because a preset
	 * that kept it could shrink the image out from under a pan and leave an empty frame. */
	fun toRatio(ratio: Float) {
		val b = bounds ?: return
		scale = ZoomMath.scaleForRatio(ratio, b, containerWidth, containerHeight)
		offsetX = 0f
		offsetY = 0f
	}

	fun toFit() {
		scale = ZoomMath.FIT
		offsetX = 0f
		offsetY = 0f
	}

	fun transform(panX: Float, panY: Float, gestureZoom: Float) {
		val b = bounds ?: return
		val domain = ZoomMath.domain(b, containerWidth, containerHeight)
		scale = (scale * gestureZoom).coerceIn(domain.min, domain.max)
		val pan = ZoomMath.panBounds(b, containerWidth, containerHeight, scale)
		offsetX = (offsetX + panX).coerceIn(-pan.maxX, pan.maxX)
		offsetY = (offsetY + panY).coerceIn(-pan.maxY, pan.maxY)
	}
}

private sealed interface DecodeOutcome {
	data object Loading : DecodeOutcome

	data object Failed : DecodeOutcome

	data class Ready(val image: DecodedImage) : DecodeOutcome
}

@Composable
private fun ZoomableImage(file: File, zoom: ZoomState) {
	val outcome by produceState<DecodeOutcome>(DecodeOutcome.Loading, file.path) {
		value = withContext(Dispatchers.IO) {
			decodeBounded(file)?.let { DecodeOutcome.Ready(it) } ?: DecodeOutcome.Failed
		}
	}
	when (val state = outcome) {
		DecodeOutcome.Loading -> CircularProgressIndicator(color = Color.White)
		DecodeOutcome.Failed -> Text("Could not decode image", color = Color.White)
		is DecodeOutcome.Ready -> ImageStage(file.name, state.image, zoom)
	}
}

@Composable
private fun ImageStage(name: String, image: DecodedImage, zoom: ZoomState) {
	BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
		// Raw pixel constraints, deliberately not Dp: the presets compare against the image's own
		// pixels, and a Dp round trip would be off by the display density on every real device.
		val frameWidth = constraints.maxWidth
		val frameHeight = constraints.maxHeight
		LaunchedEffect(image.bounds, frameWidth, frameHeight) {
			if (frameWidth <= 0 || frameHeight <= 0 || frameWidth == Int.MAX_VALUE || frameHeight == Int.MAX_VALUE) {
				return@LaunchedEffect
			}
			zoom.bounds = image.bounds
			zoom.containerWidth = frameWidth
			zoom.containerHeight = frameHeight
			zoom.toFit()
		}
		val nearest = ZoomMath.useNearestNeighbour(image.bounds, frameWidth, frameHeight, zoom.scale)
		val imageBitmap = remember(image.bitmap) { image.bitmap.asImageBitmap() }
		// Built explicitly and keyed on the quality as well as the bitmap. The Image(bitmap = ...)
		// overload remembers its painter on the bitmap alone, which would freeze sampling at whatever
		// it was when the viewer opened (smooth, since it opens fitted) and make the toggle inert.
		val painter = remember(imageBitmap, nearest) {
			BitmapPainter(imageBitmap, filterQuality = if (nearest) FilterQuality.None else FilterQuality.Medium)
		}
		Image(
			painter = painter,
			contentDescription = name,
			contentScale = ContentScale.Fit,
			modifier = Modifier
				.fillMaxSize()
				.pointerInput(image.bounds, frameWidth, frameHeight) {
					detectTransformGestures { _, pan, gestureZoom, _ -> zoom.transform(pan.x, pan.y, gestureZoom) }
				}
				.graphicsLayer(
					scaleX = zoom.scale,
					scaleY = zoom.scale,
					translationX = zoom.offsetX,
					translationY = zoom.offsetY,
				),
		)
	}
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

/** The stage for anything that is not a decodable image or a video: a text preview when the bytes
 * are text, the file glyph when they are not. Same sheet as the media viewer, so the name and the
 * actions sit where the user just saw them. */
@Composable
private fun FileStage(att: OpenAttachment) {
	val preview by produceState<TextPreview>(TextPreview.Loading, att.file.path) {
		value = withContext(Dispatchers.IO) {
			val text = TextPeek.read(att.file)?.let { TextPeek.preview(it) }
			if (text.isNullOrEmpty()) TextPreview.None else TextPreview.Text(text)
		}
	}
	when (val p = preview) {
		TextPreview.Loading -> CircularProgressIndicator(color = Color.White)
		TextPreview.None -> FileGlyph(att.mime)
		is TextPreview.Text -> Text(
			p.value,
			color = Color.White,
			style = MaterialTheme.typography.bodySmall,
			fontFamily = FontFamily.Monospace,
			modifier = Modifier
				.fillMaxSize()
				// Text is the only stage anchored to the TOP edge, so it is the only one that
				// collides with the status bar. A centred image or glyph never reaches it.
				.statusBarsPadding()
				// The preview runs to 4 KB, which is taller than any phone: without this it is
				// clipped mid-screen with nothing to say the rest exists.
				.verticalScroll(rememberScrollState())
				.padding(12.dp),
		)
	}
}

private sealed interface TextPreview {
	data object Loading : TextPreview

	data object None : TextPreview

	data class Text(val value: String) : TextPreview
}

@Composable
private fun FileGlyph(mime: String) {
	Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
		Icon(
			Icons.AutoMirrored.Filled.InsertDriveFile,
			contentDescription = null,
			tint = Color.White,
			modifier = Modifier.size(96.dp),
		)
		Text(mime.ifBlank { "unknown type" }, color = Color.White, style = MaterialTheme.typography.bodySmall)
	}
}

/** Where Save will put the file, and a way to change it. Says "Downloads" while no folder is
 * chosen, which is where the first save genuinely goes rather than a placeholder. */
@Composable
private fun SaveLocationRow(folder: String?, onPick: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().padding(horizontal = 12.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Text(
			"Save to  ${folder ?: "Downloads"}",
			color = Color.White,
			style = MaterialTheme.typography.labelSmall,
			maxLines = 1,
			overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f),
		)
		TextButton(onClick = hapticClick(onPick)) { Text("Change", color = Color.White) }
	}
}

/** Size, dimensions, modified date, and where a picked file came from, each shown only when actually
 * known. Dimensions drop for a non-image, a date the sender never stamped hides rather than reading
 * as epoch, and only a draft ever has a source to show. */
@Composable
private fun InfoRows(att: OpenAttachment, bounds: ImageBounds?) {
	val size = prettySize(att.size ?: att.file.length().takeIf { it > 0 })
	val dims = bounds?.let { "${it.sourceWidth} x ${it.sourceHeight}" }
	val modified = att.modifiedAt?.let {
		runCatching { DateFormat.getDateTimeInstance().format(Date(it)) }.getOrNull()
	}
	if (size == null && dims == null && modified == null && att.location == null) return
	Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
		val sizeLine = listOfNotNull(size, dims).joinToString("  -  ")
		if (sizeLine.isNotEmpty()) {
			Text("Size  $sizeLine", color = Color.White, style = MaterialTheme.typography.labelSmall)
		}
		if (modified != null) {
			Text("Modified  $modified", color = Color.White, style = MaterialTheme.typography.labelSmall)
		}
		if (att.location != null) {
			Text("From  ${att.location}", color = Color.White, style = MaterialTheme.typography.labelSmall)
		}
	}
}
