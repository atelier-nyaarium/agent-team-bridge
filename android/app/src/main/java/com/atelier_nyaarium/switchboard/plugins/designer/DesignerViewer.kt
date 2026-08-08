package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

////////////////////////////////
//  Interfaces & Types

/** What the full-screen viewer is showing. A [Gallery] target holds only an index and renders from
 * the LIVE `cards` list, so a re-push updating a canvas is reflected while the viewer stays open. A
 * [Chip] target is a standalone exact file (a tapped chip), independent of the gallery. */
internal sealed interface ViewerTarget {
	data class Gallery(val index: Int) : ViewerTarget

	data class Chip(val card: DesignerCard) : ViewerTarget
}

////////////////////////////////
//  Functions & Helpers

/** A render surface for agent-authored card HTML, static-only by security design: no JS, no
 * network, no file/content access, no navigation - a hostile card renders as inert markup.
 * Pinch-zoom stays on so a full mockup is inspectable. */
private fun sandboxedCardWebView(ctx: Context): WebView = WebView(ctx).apply {
	settings.javaScriptEnabled = false
	settings.blockNetworkLoads = true
	settings.blockNetworkImage = true
	settings.allowFileAccess = false
	settings.allowContentAccess = false
	settings.setSupportZoom(true)
	settings.builtInZoomControls = true
	settings.displayZoomControls = false
	settings.useWideViewPort = true
	settings.loadWithOverviewMode = true
	webViewClient = object : WebViewClient() {
		@Deprecated("Deprecated in Java")
		override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = true
	}
}

/** Share a card's HTML file through the FileProvider share sheet. */
private fun shareCard(context: Context, file: File) {
	runCatching {
		val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
		val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
			type = "text/html"
			putExtra(android.content.Intent.EXTRA_STREAM, uri)
			addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
		}
		context.startActivity(android.content.Intent.createChooser(send, "Share canvas"))
	}
}

////////////////////////////////
//  Composables

@Composable
internal fun CanvasViewer(
	items: List<DesignerCard>,
	index: Int,
	filesDir: File,
	allowDelete: Boolean,
	onIndex: (Int) -> Unit,
	onAction: (DesignerCard, CardAction) -> Unit,
	onRetry: (DesignerCard) -> Unit,
	onClose: () -> Unit,
) {
	val context = LocalContext.current
	val card = items[index]
	var menuOpen by remember { mutableStateOf(false) }
	val actions = if (allowDelete) CardAction.entries else CardAction.entries.filter { it != CardAction.DELETE }
	// Produced value carries the rel it was read for: produceState keeps the prior value across a
	// key change until the new read lands, so the render gates on a match and never paints the
	// previous canvas under the new card's identity. A byte-less card produces nothing and the
	// stage below says why instead.
	// Pair(rel, html?) once the read has SETTLED: a null html is a definite "cannot render this"
	// (purged, oversize, unreadable), which the stage must say rather than sitting blank forever.
	// Newly reachable because ingest docks a card from its declared role alone, without opening it.
	val loaded by produceState<Pair<String, String?>?>(initialValue = null, card.rel) {
		val rel = card.rel
		if (rel != null) {
			value = rel to withContext(Dispatchers.IO) { readCardHtml(filesDir, rel) }
		}
	}
	Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
		Surface(Modifier.fillMaxSize()) {
			Column {
				Row(
					Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					IconButton(onClick = onClose) { Icon(Icons.Default.Close, contentDescription = "Close canvas") }
					Column(Modifier.weight(1f)) {
						Text(card.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
						if (items.size > 1) {
							Text(
								"Canvas ${index + 1} of ${items.size}",
								style = MaterialTheme.typography.bodySmall,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
							)
						}
					}
					IconButton(
						enabled = card.rel != null,
						onClick = { card.rel?.let { r -> cardFile(filesDir, r) }?.let { shareCard(context, it) } },
					) {
						Icon(Icons.Default.Share, contentDescription = "Share canvas")
					}
					Box {
						IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Canvas actions") }
						DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
							actions.forEach { action ->
								val needsBytes = action == CardAction.REATTACH || action == CardAction.DOWNLOAD
								DropdownMenuItem(
									text = { Text(action.label) },
									enabled = !needsBytes || card.rel != null,
									onClick = {
										menuOpen = false
										onAction(card, action)
									},
								)
							}
						}
					}
				}
				Box(Modifier.weight(1f).fillMaxWidth()) {
					val match = loaded?.takeIf { it.first == card.rel }
					val html = match?.second
					when {
						html != null -> AndroidView(
							factory = { ctx -> sandboxedCardWebView(ctx) },
							update = { wv ->
								if (wv.tag != card.rel) {
									wv.tag = card.rel
									wv.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
								}
							},
							onRelease = { it.destroy() },
							modifier = Modifier.fillMaxSize(),
						)
						match != null -> Column(
							Modifier.align(Alignment.Center),
							horizontalAlignment = Alignment.CenterHorizontally,
						) {
							// The bytes are here and cannot be rendered: too large for the viewer, or
							// swept from the bucket. A blank stage would read as a dead tap.
							Icon(
								Icons.Default.ErrorOutline,
								contentDescription = null,
								modifier = Modifier.size(34.dp),
								tint = MaterialTheme.colorScheme.onSurfaceVariant,
							)
							Text(
								"This canvas can't be displayed",
								style = MaterialTheme.typography.bodyMedium,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
								modifier = Modifier.padding(top = 8.dp),
							)
						}
						card.rel == null && card.fetchFailed -> Column(
							Modifier.align(Alignment.Center),
							horizontalAlignment = Alignment.CenterHorizontally,
						) {
							Icon(
								Icons.Default.ErrorOutline,
								contentDescription = null,
								modifier = Modifier.size(34.dp),
								tint = MaterialTheme.colorScheme.error,
							)
							Text(
								"Couldn't download this canvas",
								style = MaterialTheme.typography.bodyMedium,
								color = MaterialTheme.colorScheme.error,
								modifier = Modifier.padding(top = 8.dp),
							)
							TextButton(onClick = { onRetry(card) }) { Text("Retry") }
						}
						card.rel == null -> Column(
							Modifier.align(Alignment.Center),
							horizontalAlignment = Alignment.CenterHorizontally,
						) {
							CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
							Text(
								"Downloading...",
								style = MaterialTheme.typography.bodyMedium,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
								modifier = Modifier.padding(top = 10.dp),
							)
						}
					}
					if (index > 0) NavArrow(Modifier.align(Alignment.CenterStart), left = true) { onIndex(index - 1) }
					if (index < items.size - 1) NavArrow(Modifier.align(Alignment.CenterEnd), left = false) { onIndex(index + 1) }
				}
				if (items.size > 1) {
					Row(
						Modifier.fillMaxWidth().padding(vertical = 10.dp),
						horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
					) {
						items.indices.forEach { i ->
							Box(
								Modifier.size(if (i == index) 10.dp else 7.dp).background(
									if (i == index) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
									CircleShape,
								),
							)
						}
					}
				}
			}
		}
	}
}

@Composable
private fun NavArrow(modifier: Modifier, left: Boolean, onClick: () -> Unit) {
	Surface(modifier = modifier.padding(6.dp), shape = CircleShape, tonalElevation = 6.dp) {
		IconButton(onClick = onClick) {
			if (left) {
				Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Previous canvas")
			} else {
				Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Next canvas")
			}
		}
	}
}
