package com.atelier_nyaarium.switchboard

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.io.File

////////////////////////////////
//  Composables

private val TILE = 64.dp

/** Named tiles are wider than square ones: only the strip's HEIGHT has to stay fixed, and a filename
 * squeezed into a square is not a label. */
private val NAMED_TILE_WIDTH = 104.dp

/** Identity for a tile's slot. A draft's srcs are unique (each pick mints its own bucket), and the
 * name is only a fallback for a row that names no bytes yet. */
private fun tileKey(file: MessageFile): String = file.src ?: "name:${file.name}"

/**
 * The composer's picked files. Collapsed to a fixed-height strip so a dozen attachments cannot push
 * the text field off screen; expanded mirrors how they will render once sent, which is what makes
 * this a pre-send check rather than a second differently-shaped list.
 *
 * The expand state is composer-local: it describes how the user is looking at the draft, not the
 * draft, so it must not outlive the screen the way `Draft` does.
 */
@Composable
internal fun DraftAttachments(
	files: List<MessageFile>,
	filesDir: File,
	onOpen: (MessageFile) -> Unit,
	onRemove: (String) -> Unit,
) {
	if (files.isEmpty()) return
	var expanded by remember { mutableStateOf(false) }

	Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 4.dp)) {
		Row(verticalAlignment = Alignment.CenterVertically) {
			Text(
				if (files.size == 1) "1 attachment" else "${files.size} attachments",
				style = MaterialTheme.typography.labelSmall,
				modifier = Modifier.weight(1f),
			)
			IconButton(onClick = hapticClick { expanded = !expanded }, modifier = Modifier.size(28.dp)) {
				Icon(
					if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
					contentDescription = if (expanded) "Collapse attachments" else "Expand attachments",
				)
			}
		}
		if (expanded) {
			ExpandedAttachments(files, filesDir, onOpen, onRemove)
		} else {
			CollapsedStrip(files, filesDir, onOpen, onRemove)
		}
	}
}

/** One row, scrolled horizontally. */
@Composable
private fun CollapsedStrip(
	files: List<MessageFile>,
	filesDir: File,
	onOpen: (MessageFile) -> Unit,
	onRemove: (String) -> Unit,
) {
	val listState = rememberLazyListState()
	var previousCount by remember { mutableIntStateOf(files.size) }
	// Only a GROWING list scrolls: the newest file is the one the user just chose and would otherwise
	// be off the end. Keying on size alone would also yank the strip on a removal.
	LaunchedEffect(files.size) {
		if (files.size > previousCount && files.isNotEmpty()) listState.animateScrollToItem(files.lastIndex)
		previousCount = files.size
	}
	LazyRow(
		state = listState,
		modifier = Modifier.fillMaxWidth().height(TILE),
		horizontalArrangement = Arrangement.spacedBy(6.dp),
	) {
		// Keyed by the file, not by position. With positional keys a removal shifts every later file
		// down a slot while that slot keeps the previous file's decoded bitmap, so the user would see
		// one image on a tile whose remove badge deletes a different file.
		items(files.size, key = { i -> tileKey(files[i]) }) { i ->
			val file = files[i]
			AttachmentTile(file, filesDir, onOpen = { onOpen(file) }, onRemove = { file.src?.let(onRemove) })
		}
	}
}

/** The same ordering the transcript uses, so what the user checks here is what they are about to
 * send: images first as tiles, then everything else as narrow named rows. */
@Composable
private fun ExpandedAttachments(
	files: List<MessageFile>,
	filesDir: File,
	onOpen: (MessageFile) -> Unit,
	onRemove: (String) -> Unit,
) {
	val ordered = remember(files) { displayAttachments(files) { null } }
	val tiles = ordered.filter { it.previewable }
	val rows = ordered.filterNot { it.previewable }
	Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
		if (tiles.isNotEmpty()) {
			// Wraps, because the transcript this mirrors wraps. A single Row would place the sixth
			// tile past the screen edge, where it cannot be seen, tapped, or removed, while the
			// header above still counted it.
			FlowRow(
				horizontalArrangement = Arrangement.spacedBy(6.dp),
				verticalArrangement = Arrangement.spacedBy(6.dp),
			) {
				tiles.forEach { item ->
					key(tileKey(item.file)) {
						AttachmentTile(
							item.file,
							filesDir,
							onOpen = { onOpen(item.file) },
							onRemove = { item.file.src?.let(onRemove) },
						)
					}
				}
			}
		}
		rows.forEach { item ->
			Surface(
				color = MaterialTheme.colorScheme.surfaceVariant,
				shape = MaterialTheme.shapes.small,
				modifier = Modifier.fillMaxWidth(),
			) {
				Row(
					Modifier.clickable(onClick = hapticClick { onOpen(item.file) })
						.padding(start = 10.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					Text(
						displayName(item),
						style = MaterialTheme.typography.labelSmall,
						fontFamily = FontFamily.Monospace,
						maxLines = 1,
						overflow = TextOverflow.Ellipsis,
						modifier = Modifier.weight(1f),
					)
					IconButton(onClick = hapticClick { item.file.src?.let(onRemove) }) {
						Icon(Icons.Default.Close, contentDescription = "Remove attachment")
					}
				}
			}
		}
	}
}

/** A tapped tile opens the same fullscreen viewer a sent attachment does; without this a draft file
 * is the one attachment in the app with no way to look at it before sending. */
@Composable
private fun AttachmentTile(
	file: MessageFile,
	filesDir: File,
	onOpen: () -> Unit,
	onRemove: () -> Unit,
) {
	val thumb by produceState<Bitmap?>(null, file.src, file.blobId) {
		value = ImageThumbs.of(filesDir, file)
	}
	val width = if (thumb != null) TILE else NAMED_TILE_WIDTH
	Box(Modifier.height(TILE).width(width)) {
		Surface(
			color = MaterialTheme.colorScheme.surfaceVariant,
			shape = MaterialTheme.shapes.small,
			modifier = Modifier.fillMaxSize().clickable(onClick = hapticClick(onOpen)),
		) {
			val bitmap = thumb
			if (bitmap != null) {
				Image(
					bitmap = bitmap.asImageBitmap(),
					contentDescription = file.name,
					contentScale = ContentScale.Crop,
					modifier = Modifier.fillMaxSize(),
				)
			} else {
				// Named rather than iconed: a generic glyph would make a row of these
				// indistinguishable. The top inset keeps the name out from under the remove badge.
				Text(
					file.name,
					style = MaterialTheme.typography.labelSmall,
					fontFamily = FontFamily.Monospace,
					textAlign = TextAlign.Center,
					maxLines = 2,
					overflow = TextOverflow.Ellipsis,
					modifier = Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = 22.dp, bottom = 4.dp),
				)
			}
		}
		Box(
			Modifier.align(Alignment.TopEnd).padding(2.dp).size(18.dp)
				.clip(CircleShape)
				.background(Color(0xCC000000))
				.clickable(onClick = hapticClick(onRemove)),
			contentAlignment = Alignment.Center,
		) {
			Icon(
				Icons.Default.Close,
				contentDescription = "Remove attachment",
				tint = Color.White,
				modifier = Modifier.size(12.dp),
			)
		}
	}
}
