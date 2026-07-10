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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.hapticClickable
import java.io.File
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

////////////////////////////////
//  Functions & Helpers

/** Resolve a materialized attachment's renderer URL back to its on-disk HTML, through the same
 * path-safety gate the attachment viewer uses. Bounded read: a card is small by contract (the
 * mockup corpus is ~10 KB each), and a mislabeled giant file must not stall the dock derivation.
 * An oversize file is logged rather than dropped in silence, so a card that never appears is
 * diagnosable instead of a mystery. */
internal fun readAttachmentHtml(filesDir: File, src: String, capBytes: Int = 4 * 1024 * 1024): String? {
	val rel = src.substringAfter("/${Attachments.DIR}/", missingDelimiterValue = "")
	if (rel.isEmpty()) return null
	val file = Attachments.resolve(filesDir, rel) ?: return null
	if (file.length() > capBytes) {
		com.atelier_nyaarium.switchboard.DebugLog.log("Designer", "card ${file.name} is ${file.length()}B > ${capBytes}B cap; not rendered")
		return null
	}
	return runCatching { file.readText() }.getOrNull()
}

/** Share a card's HTML file through the app's FileProvider (attachments/ is exposed in
 * file_paths.xml), so a design can leave the app via the standard Android share sheet. */
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

/** A render surface for agent-authored card HTML, static-only per the designer security model
 * (plans/designer.md): no JS, no network, no file/content access, no navigation - a hostile
 * card renders as inert markup. Pinch-zoom stays on so a full mockup is inspectable. */
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

private fun shortTime(at: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))

////////////////////////////////
//  Composables

/**
 * The Designer dock: a fixed bar above the composer, present only when the open conversation has
 * design cards, expanding into the canvas list, each canvas opening full-screen. The three-view
 * UX is the approved design pass (temp/switchboard-designer-dock/).
 */
@Composable
fun DesignerDock(team: String) {
	val context = LocalContext.current
	val repo = remember { Repo.get(context) }
	val state by repo.state.collectAsState()
	val messages = state.threads[team] ?: emptyList()
	val filesDir = context.filesDir
	// Card derivation reads materialized files, so it runs off the UI thread and re-derives when
	// the thread's messages change.
	val cards by produceState(initialValue = emptyList<DesignerCard>(), messages) {
		value = withContext(Dispatchers.IO) {
			designerCards(messages) { src -> readAttachmentHtml(filesDir, src) }
		}
	}
	if (cards.isEmpty()) return
	// Keyed by team: the dock is one composable instance reused across tab/session switches (the
	// team ARG changes, the instance does not), so unkeyed state would carry an open sheet or
	// full-screen canvas from one conversation into the next.
	var expanded by remember(team) { mutableStateOf(false) }
	var openIndex by remember(team) { mutableStateOf<Int?>(null) }

	DockBar(cards) { expanded = true }
	if (expanded) {
		CanvasSheet(
			cards = cards,
			onOpen = {
				openIndex = it
				expanded = false
			},
			onDismiss = { expanded = false },
		)
	}
	openIndex?.let { index ->
		CanvasViewer(
			cards = cards,
			index = index.coerceIn(0, cards.size - 1),
			filesDir = filesDir,
			onIndex = { openIndex = it },
			onClose = { openIndex = null },
		)
	}
}

@Composable
private fun DockBar(cards: List<DesignerCard>, onExpand: () -> Unit) {
	Surface(tonalElevation = 3.dp) {
		Row(
			Modifier.fillMaxWidth().hapticClickable(onClick = onExpand).padding(horizontal = 12.dp, vertical = 8.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Box(
				Modifier.size(34.dp).background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(9.dp)),
				contentAlignment = Alignment.Center,
			) {
				Icon(Icons.Default.GridView, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
			}
			Column(Modifier.weight(1f).padding(horizontal = 11.dp)) {
				Text("Designer", style = MaterialTheme.typography.titleSmall)
				Text(
					"${cards.size} ${if (cards.size == 1) "canvas" else "canvases"} - updated ${shortTime(cards.maxOf { it.updatedAt })}",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			Icon(Icons.Default.ExpandLess, contentDescription = "Expand designs", tint = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CanvasSheet(cards: List<DesignerCard>, onOpen: (Int) -> Unit, onDismiss: () -> Unit) {
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
			items(cards.size) { i ->
				val card = cards[i]
				Row(
					Modifier.fillMaxWidth().hapticClickable { onOpen(i) }.padding(horizontal = 16.dp, vertical = 10.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					// A generic canvas glyph stands in for a real thumbnail (snapshot thumbnails
					// are deferred polish; see plans/plugins.md).
					Box(
						Modifier.size(width = 44.dp, height = 58.dp)
							.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)),
						contentAlignment = Alignment.Center,
					) {
						Icon(
							Icons.Default.GridView,
							contentDescription = null,
							modifier = Modifier.size(18.dp),
							tint = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
					Column(Modifier.weight(1f).padding(horizontal = 13.dp)) {
						Text(card.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
						val dims = card.meta.width?.let { w -> card.meta.height?.let { h -> "$w x $h" } }
						Text(
							listOfNotNull("updated ${shortTime(card.updatedAt)}", dims).joinToString("  "),
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
					Icon(
						Icons.AutoMirrored.Filled.KeyboardArrowRight,
						contentDescription = null,
						tint = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			}
		}
	}
}

@Composable
private fun CanvasViewer(
	cards: List<DesignerCard>,
	index: Int,
	filesDir: File,
	onIndex: (Int) -> Unit,
	onClose: () -> Unit,
) {
	val context = LocalContext.current
	val card = cards[index]
	// Read the card's HTML off the UI thread, re-reading when the pager moves. The produced value
	// carries the src it was read FOR: produceState keeps the prior value across a key change until
	// the new read lands, so pairing the html with its src lets the render gate on a match and
	// never paint the previous canvas under the new card's identity.
	val loaded by produceState<Pair<String, String>?>(initialValue = null, card.src) {
		val text = withContext(Dispatchers.IO) { readAttachmentHtml(filesDir, card.src) }
		value = text?.let { card.src to it }
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
						Text(
							"Canvas ${index + 1} of ${cards.size}",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
					IconButton(onClick = {
						Attachments.resolve(filesDir, card.src.substringAfter("/${Attachments.DIR}/", ""))
							?.let { shareCard(context, it) }
					}) {
						Icon(Icons.Default.Share, contentDescription = "Share canvas")
					}
				}
				Box(Modifier.weight(1f).fillMaxWidth()) {
					// Gate on the loaded pair matching THIS card: while a page turn's read is in
					// flight the pair still holds the previous card, so the WebView leaves
					// composition (destroyed via onRelease) and remounts fresh for the new card -
					// no stale-content-under-new-tag freeze, no leaked instance.
					val match = loaded?.takeIf { it.first == card.src }
					if (match != null) {
						AndroidView(
							factory = { ctx -> sandboxedCardWebView(ctx) },
							update = { wv ->
								// The WebView is fresh per card (tag starts null), so load once and
								// let later recompositions no-op - reloading would reset the user's zoom.
								if (wv.tag == null) {
									wv.tag = match.first
									wv.loadDataWithBaseURL(null, match.second, "text/html", "utf-8", null)
								}
							},
							onRelease = { it.destroy() },
							modifier = Modifier.fillMaxSize(),
						)
					}
					if (index > 0) {
						NavArrow(Modifier.align(Alignment.CenterStart), left = true) { onIndex(index - 1) }
					}
					if (index < cards.size - 1) {
						NavArrow(Modifier.align(Alignment.CenterEnd), left = false) { onIndex(index + 1) }
					}
				}
				Row(
					Modifier.fillMaxWidth().padding(vertical = 10.dp),
					horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
				) {
					cards.indices.forEach { i ->
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
