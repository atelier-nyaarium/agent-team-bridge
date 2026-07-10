package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.mutableIntStateOf
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
import com.atelier_nyaarium.switchboard.plugins.ThreadDockScope
import com.atelier_nyaarium.switchboard.saveFileToDownloads
import java.io.File
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

////////////////////////////////
//  Functions & Helpers

/** The attachment-relative path (`<bucket>/<name>`) inside an appassets card src. */
internal fun relOf(src: String): String = src.substringAfter("/${Attachments.DIR}/", "")

/** Resolve a card src to its on-disk HTML through the same path-safety gate the attachment viewer
 * uses. Bounded read: a card is small by contract (the mockup corpus is ~10 KB each); an oversize
 * file is logged rather than dropped in silence so a card that never appears is diagnosable. */
internal fun readAttachmentHtml(filesDir: File, src: String, capBytes: Int = 4 * 1024 * 1024): String? {
	val rel = relOf(src)
	if (rel.isEmpty()) return null
	val file = Attachments.resolve(filesDir, rel) ?: return null
	if (file.length() > capBytes) {
		com.atelier_nyaarium.switchboard.DebugLog.log("Designer", "card ${file.name} is ${file.length()}B > ${capBytes}B cap; not rendered")
		return null
	}
	return runCatching { file.readText() }.getOrNull()
}

private fun cardFile(filesDir: File, version: DesignerVersion): File? =
	Attachments.resolve(filesDir, relOf(version.src))

/** Re-send a version's bytes as a fresh outbound attachment, reusing the composer's own send path
 * via a FileProvider URI (attachments/ is exposed in file_paths.xml). Launched on a process-lifetime
 * scope so closing the thread mid-send cannot cancel it (matching the composer's App-scoped send). */
private fun reattach(context: Context, team: String, file: File) {
	runCatching {
		val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
		designerSendScope.launch { Repo.get(context).send(team, "", listOf(uri)) }
	}
}

/** Share a card version's HTML file through the FileProvider share sheet. */
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

/** The set of row/viewer actions, so the sheet's context menu and the viewer's action bar stay
 * in lockstep. Each action operates on a specific (card, version). */
private enum class CardAction(val label: String) {
	REFERENCE("Reference in chat"),
	REATTACH("Reattach to chat"),
	DOWNLOAD("Download"),
	DELETE("Delete"),
}

////////////////////////////////
//  Composables

/**
 * The Designer dock: a fixed bar above the composer, present only when the open conversation has
 * design cards, expanding into the canvas list, each canvas opening full-screen with version
 * history and a per-card action set. The UX is the approved design pass (temp/switchboard-designer-dock/).
 */
@Composable
fun DesignerDock(scope: ThreadDockScope) {
	val team = scope.team
	val context = LocalContext.current
	val repo = remember { Repo.get(context) }
	val store = remember { DesignStore(context) }
	val state by repo.state.collectAsState()
	val messages = state.threads[team] ?: emptyList()
	val filesDir = context.filesDir
	// Bumped by Delete (which changes the store, not the messages) to force a re-derive.
	var refresh by remember(team) { mutableIntStateOf(0) }
	val cards by produceState(initialValue = emptyList<DesignerCard>(), messages, refresh, team) {
		value = withContext(Dispatchers.IO) {
			designerCards(messages, store.dismissed(team)) { src -> readAttachmentHtml(filesDir, src) }
		}
	}

	// Keyed by team: the dock is one composable instance reused across tab/session switches (the
	// scope changes, the instance does not), so unkeyed state would carry an open sheet or canvas
	// from one conversation into the next.
	var expanded by remember(team) { mutableStateOf(false) }
	var openIndex by remember(team) { mutableStateOf<Int?>(null) }

	// Chip-tap hand-off: a tap on a card-marked attachment in the chat body opens that card here.
	// Events (replay 0) never replay on re-entry; the target rel is held until `cards` resolves it,
	// so a tap that beats the async re-derive still opens the right card. State is remember(team),
	// so nothing crosses into another conversation.
	var pendingOpenRel by remember(team) { mutableStateOf<String?>(null) }
	androidx.compose.runtime.LaunchedEffect(team) {
		DesignerOpenBus.events.collect { req -> if (req.team == team) pendingOpenRel = req.rel }
	}
	androidx.compose.runtime.LaunchedEffect(pendingOpenRel, cards) {
		val rel = pendingOpenRel ?: return@LaunchedEffect
		val idx = cards.indexOfFirst { c -> c.versions.any { it.src.endsWith("/$rel") } }
		if (idx >= 0) {
			pendingOpenRel = null
			expanded = false
			openIndex = idx
		}
	}

	if (cards.isEmpty()) return

	DockBar(cards) { expanded = true }
	if (expanded) {
		CanvasSheet(
			cards = cards,
			onOpen = {
				openIndex = it
				expanded = false
			},
			onAction = { card, action -> runAction(context, scope, store, filesDir, card, card.versions.lastIndex, action) { refresh++ } },
			onDismiss = { expanded = false },
		)
	}
	openIndex?.let { index ->
		if (index in cards.indices) {
			CanvasViewer(
				cards = cards,
				index = index,
				filesDir = filesDir,
				onIndex = { openIndex = it },
				onAction = { card, versionIndex, action ->
					runAction(context, scope, store, filesDir, card, versionIndex, action) {
						refresh++
						if (action == CardAction.DELETE) openIndex = null
					}
				},
				onClose = { openIndex = null },
			)
		}
	}
}

/** Execute one card action against a specific version; [onChanged] fires for store-mutating
 * actions so the caller re-derives. */
private fun runAction(
	context: Context,
	scope: ThreadDockScope,
	store: DesignStore,
	filesDir: File,
	card: DesignerCard,
	versionIndex: Int,
	action: CardAction,
	onChanged: () -> Unit,
) {
	val version = card.versions.getOrNull(versionIndex) ?: card.latest
	when (action) {
		CardAction.REFERENCE -> scope.insertDraftText("**${card.name}** ")
		CardAction.REATTACH -> cardFile(filesDir, version)?.let { reattach(context, scope.team, it) }
		CardAction.DOWNLOAD -> {
			val ok = cardFile(filesDir, version)?.let { saveFileToDownloads(context, it, card.fileName, "text/html") } ?: false
			Toast.makeText(context, if (ok) "Saved to Downloads" else "Couldn't save", Toast.LENGTH_SHORT).show()
		}
		CardAction.DELETE -> {
			store.dismiss(scope.team, card.fileName, card.updatedAt)
			onChanged()
			return
		}
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
private fun CanvasSheet(
	cards: List<DesignerCard>,
	onOpen: (Int) -> Unit,
	onAction: (DesignerCard, CardAction) -> Unit,
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
				CanvasRow(cards[i], onOpen = { onOpen(i) }, onAction = { onAction(cards[i], it) })
			}
		}
	}
}

@Composable
private fun CanvasRow(card: DesignerCard, onOpen: () -> Unit, onAction: (CardAction) -> Unit) {
	var menuOpen by remember { mutableStateOf(false) }
	Row(
		Modifier.fillMaxWidth().hapticClickable(onClick = onOpen).padding(start = 16.dp, end = 4.dp).padding(vertical = 10.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Box(
			Modifier.size(width = 44.dp, height = 58.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)),
			contentAlignment = Alignment.Center,
		) {
			Icon(Icons.Default.GridView, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		Column(Modifier.weight(1f).padding(horizontal = 13.dp)) {
			Text(card.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
			val dims = card.meta.width?.let { w -> card.meta.height?.let { h -> "$w x $h" } }
			val versionNote = if (card.versions.size > 1) "v${card.versions.size}" else null
			Text(
				listOfNotNull("updated ${shortTime(card.updatedAt)}", versionNote, dims).joinToString("  "),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		Box {
			IconButton(onClick = { menuOpen = true }) {
				Icon(Icons.Default.MoreVert, contentDescription = "Canvas actions")
			}
			DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
				CardAction.entries.forEach { action ->
					DropdownMenuItem(
						text = { Text(action.label) },
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

@Composable
private fun CanvasViewer(
	cards: List<DesignerCard>,
	index: Int,
	filesDir: File,
	onIndex: (Int) -> Unit,
	onAction: (DesignerCard, Int, CardAction) -> Unit,
	onClose: () -> Unit,
) {
	val context = LocalContext.current
	val card = cards[index]
	// Default to the newest version; the stepper lets an older one be viewed (and acted on). Keyed
	// on fileName ONLY (not version count), so a new version streaming in while an older revision is
	// open does not yank the user to latest - the coerce keeps the index valid as history grows.
	var versionIndex by remember(card.fileName) { mutableIntStateOf(card.versions.lastIndex) }
	val safeIndex = versionIndex.coerceIn(0, card.versions.lastIndex)
	val version = card.versions[safeIndex]
	var menuOpen by remember { mutableStateOf(false) }
	val loaded by produceState<Pair<String, String>?>(initialValue = null, version.src) {
		val text = withContext(Dispatchers.IO) { readAttachmentHtml(filesDir, version.src) }
		value = text?.let { version.src to it }
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
						val v = if (card.versions.size > 1) " - v${safeIndex + 1}/${card.versions.size}" else ""
						Text(
							"Canvas ${index + 1} of ${cards.size}$v",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
					IconButton(onClick = { cardFile(filesDir, version)?.let { shareCard(context, it) } }) {
						Icon(Icons.Default.Share, contentDescription = "Share canvas")
					}
					Box {
						IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Canvas actions") }
						DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
							CardAction.entries.forEach { action ->
								DropdownMenuItem(
									text = { Text(action.label) },
									onClick = {
										menuOpen = false
										onAction(card, safeIndex, action)
									},
								)
							}
						}
					}
				}
				if (card.versions.size > 1) {
					VersionBar(
						versionIndex = safeIndex,
						count = card.versions.size,
						at = version.at,
						onVersion = { versionIndex = it },
					)
				}
				Box(Modifier.weight(1f).fillMaxWidth()) {
					val match = loaded?.takeIf { it.first == version.src }
					if (match != null) {
						AndroidView(
							factory = { ctx -> sandboxedCardWebView(ctx) },
							update = { wv ->
								if (wv.tag != version.src) {
									wv.tag = version.src
									wv.loadDataWithBaseURL(null, match.second, "text/html", "utf-8", null)
								}
							},
							onRelease = { it.destroy() },
							modifier = Modifier.fillMaxSize(),
						)
					}
					if (index > 0) NavArrow(Modifier.align(Alignment.CenterStart), left = true) { onIndex(index - 1) }
					if (index < cards.size - 1) NavArrow(Modifier.align(Alignment.CenterEnd), left = false) { onIndex(index + 1) }
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

/** Version stepper for a card with history: prev/next across revisions, newest on the right. */
@Composable
private fun VersionBar(versionIndex: Int, count: Int, at: Long, onVersion: (Int) -> Unit) {
	Row(
		Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.Center,
	) {
		IconButton(enabled = versionIndex > 0, onClick = { onVersion(versionIndex - 1) }) {
			Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Older version")
		}
		val tag = if (versionIndex == count - 1) "latest" else "older"
		Text(
			"v${versionIndex + 1} of $count ($tag) - ${shortTime(at)}",
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		IconButton(enabled = versionIndex < count - 1, onClick = { onVersion(versionIndex + 1) }) {
			Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Newer version")
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
