package com.atelier_nyaarium.switchboard.plugins.designer

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.hapticClickable
import java.io.File
import java.text.DateFormat
import java.util.Date

////////////////////////////////
//  Functions & Helpers

private fun shortTime(at: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))

////////////////////////////////
//  Composables

@Composable
internal fun DockBar(cards: List<DesignerCard>, filesDir: File, onExpand: () -> Unit) {
	Surface(tonalElevation = 3.dp) {
		Row(
			Modifier.fillMaxWidth().hapticClickable(onClick = onExpand).padding(horizontal = 12.dp, vertical = 8.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			// The peek slot previews the most recently updated canvas. When that one has no bytes it
			// carries the state instead of a generic icon, so a stalled transfer is visible without
			// opening the sheet.
			val peek = cards.maxBy { it.updatedAt }
			CardThumb(
				filesDir = filesDir,
				card = peek,
				modifier = Modifier.size(34.dp).clip(RoundedCornerShape(9.dp)),
			) {
				PendingThumb(peek, Modifier.size(34.dp), corner = 9.dp) {
					Icon(Icons.Default.GridView, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
				}
			}
			val downloading = cards.count { it.rel == null && !it.fetchFailed }
			val failed = cards.count { it.fetchFailed }
			Column(Modifier.weight(1f).padding(horizontal = 11.dp)) {
				Text("Designer", style = MaterialTheme.typography.titleSmall)
				Text(
					"${cards.size} ${if (cards.size == 1) "canvas" else "canvases"}" +
						when {
							failed > 0 -> " - $failed couldn't download"
							downloading > 0 -> " - $downloading downloading"
							else -> " - updated ${shortTime(cards.maxOf { it.updatedAt })}"
						},
					style = MaterialTheme.typography.bodySmall,
					color = if (failed > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			Icon(Icons.Default.ExpandLess, contentDescription = "Expand designs", tint = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

/** The stateful placeholder for a thumb slot whose card has no bytes: a spinner while the fetch is
 * live, an error glyph once it has given up, and the caller's own idle glyph otherwise (a card with
 * bytes whose thumbnail simply has not rendered yet). */
@Composable
private fun PendingThumb(card: DesignerCard, modifier: Modifier, corner: androidx.compose.ui.unit.Dp, idle: @Composable () -> Unit) {
	val shape = RoundedCornerShape(corner)
	when {
		card.fetchFailed -> Box(
			modifier.background(MaterialTheme.colorScheme.errorContainer, shape),
			contentAlignment = Alignment.Center,
		) {
			Icon(
				Icons.Default.ErrorOutline,
				contentDescription = "Couldn't download",
				modifier = Modifier.size(18.dp),
				tint = MaterialTheme.colorScheme.onErrorContainer,
			)
		}
		card.rel == null -> Box(
			modifier.background(MaterialTheme.colorScheme.surfaceVariant, shape),
			contentAlignment = Alignment.Center,
		) {
			CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
		}
		else -> Box(
			modifier.background(MaterialTheme.colorScheme.secondaryContainer, shape),
			contentAlignment = Alignment.Center,
		) {
			idle()
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CanvasSheet(
	cards: List<DesignerCard>,
	filesDir: File,
	onOpen: (Int) -> Unit,
	onAction: (DesignerCard, CardAction) -> Unit,
	onRetry: (DesignerCard) -> Unit,
	onDismiss: () -> Unit,
) {
	ModalBottomSheet(onDismissRequest = onDismiss) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Box(
				Modifier.size(36.dp).background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(9.dp)),
				contentAlignment = Alignment.Center,
			) {
				Icon(Icons.Default.GridView, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
			}
			Column(Modifier.padding(start = 11.dp)) {
				Text("Designer", style = MaterialTheme.typography.titleMedium)
				Text(
					"${cards.size} ${if (cards.size == 1) "canvas" else "canvases"} in this conversation",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
		LazyColumn(Modifier.padding(bottom = 24.dp)) {
			items(cards.size, key = { cards[it].fileName }) { i ->
				CanvasRow(
					cards[i],
					filesDir,
					onOpen = { onOpen(i) },
					onAction = { onAction(cards[i], it) },
					onRetry = { onRetry(cards[i]) },
				)
			}
		}
	}
}

@Composable
private fun CanvasRow(
	card: DesignerCard,
	filesDir: File,
	onOpen: () -> Unit,
	onAction: (CardAction) -> Unit,
	onRetry: () -> Unit,
) {
	var menuOpen by remember { mutableStateOf(false) }
	Row(
		Modifier.fillMaxWidth().hapticClickable(onClick = onOpen).padding(start = 16.dp, end = 4.dp).padding(vertical = 10.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		CardThumb(
			filesDir = filesDir,
			card = card,
			modifier = Modifier.size(width = 44.dp, height = 58.dp).clip(RoundedCornerShape(8.dp)),
		) {
			PendingThumb(card, Modifier.size(width = 44.dp, height = 58.dp), corner = 8.dp) {
				Icon(
					Icons.Default.GridView,
					contentDescription = null,
					modifier = Modifier.size(18.dp),
					tint = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
		Column(Modifier.weight(1f).padding(horizontal = 13.dp)) {
			// The name and dimensions render in EVERY state: they came off the wire, so they are known
			// the instant the message lands and cannot be lost to a transfer that did not finish.
			Text(card.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
			val dims = card.meta.width?.let { w -> card.meta.height?.let { h -> "$w x $h" } }
			when {
				card.fetchFailed -> Text(
					listOfNotNull("couldn't download", dims).joinToString("  "),
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.error,
				)
				card.rel == null -> Text(
					listOfNotNull("downloading", dims).joinToString("  "),
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				else -> Text(
					listOfNotNull("updated ${shortTime(card.updatedAt)}", dims).joinToString("  "),
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			if (card.fetchFailed) {
				TextButton(onClick = onRetry, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp)) {
					Text("Retry")
				}
			}
		}
		Box {
			IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Canvas actions") }
			DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
				CardAction.entries.forEach { action ->
					// Reattach and Download read the file, so they cannot work before the bytes land.
					// Dimmed rather than hidden; Reference and Delete stay live because they do not
					// touch bytes - and Delete especially must work on a card that can never download.
					val needsBytes = action == CardAction.REATTACH || action == CardAction.DOWNLOAD
					DropdownMenuItem(
						text = { Text(action.label) },
						enabled = !needsBytes || card.rel != null,
						onClick = {
							menuOpen = false
							onAction(action)
						},
					)
				}
			}
		}
	}
}
