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
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

////////////////////////////////
//  Functions & Helpers

/** The most a card's HTML may be to render. Shared so the chip opener refuses to CLAIM anything the
 * viewer would then refuse to render (which would swallow the tap), and so an oversize file is never
 * ingested into the gallery. A card is small by contract (the mockup corpus is ~10 KB each). */
internal const val CARD_RENDER_CAP_BYTES: Long = 4L * 1024 * 1024

/** Bytes read to detect a card: the `@dsCard` marker and `<title>` both lead the file (head), so a
 * small prefix suffices. Bounded so ingest (poll thread) and a chip tap (UI thread) never read a
 * whole file just to classify it. */
private const val CARD_MARKER_PREFIX_BYTES = 8 * 1024

/** A bounded prefix of a card's HTML through the attachment path-safety gate, or null when the file
 * is gone, oversize (too big to ever render, so never gallery'd), or unreadable. Enough to parse the
 * marker + title on both the ingest path and a chip tap without reading the whole file. */
internal fun readCardPrefix(filesDir: File, rel: String, cap: Int = CARD_MARKER_PREFIX_BYTES): String? {
	if (rel.isEmpty()) return null
	val file = Attachments.resolve(filesDir, rel) ?: return null
	if (file.length() > CARD_RENDER_CAP_BYTES) return null
	return runCatching { file.inputStream().use { String(it.readNBytes(cap), Charsets.UTF_8) } }.getOrNull()
}

/** A card's full HTML for rendering (the viewer), or null when gone, oversize, or unreadable. Capped
 * by contract: a card is small (the mockup corpus is ~10 KB each). */
internal fun readCardHtml(filesDir: File, rel: String): String? {
	if (rel.isEmpty()) return null
	val file = Attachments.resolve(filesDir, rel) ?: return null
	if (file.length() > CARD_RENDER_CAP_BYTES) {
		com.atelier_nyaarium.switchboard.DebugLog.log("Designer", "card ${file.name} is ${file.length()}B > ${CARD_RENDER_CAP_BYTES}B cap; not rendered")
		return null
	}
	return runCatching { file.readText() }.getOrNull()
}

private fun cardFile(filesDir: File, rel: String): File? = Attachments.resolve(filesDir, rel)

/** Build a standalone card for an EXACT tapped attachment (chip-open), independent of the dock
 * gallery - so an older revision, or a canvas deleted from the dock, still opens the file tapped. */
internal fun buildCardForRel(filesDir: File, rel: String): DesignerCard? {
	val html = readCardHtml(filesDir, rel) ?: return null
	val meta = parseDsCardMarker(html) ?: return null
	val name = rel.substringAfterLast('/')
	return DesignerCard(name, htmlTitle(html) ?: name.substringBeforeLast('.'), rel, 0L, meta)
}

/** Re-send a card's bytes as a fresh outbound attachment, reusing the composer's own send path via
 * a FileProvider URI (attachments/ is exposed in file_paths.xml). Launched on a process-lifetime
 * scope so closing the thread mid-send cannot cancel it (matching the composer's App-scoped send). */
private fun reattach(context: Context, team: String, file: File) {
	runCatching {
		val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
		designerSendScope.launch { Repo.get(context).send(team, "", listOf(uri)) }
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

/** The set of row/viewer actions, so the sheet's context menu and the viewer's action bar stay in
 * lockstep. Each operates on the specific card being viewed. */
private enum class CardAction(val label: String) {
	REFERENCE("Reference in chat"),
	REATTACH("Reattach to chat"),
	DOWNLOAD("Download"),
	DELETE("Delete"),
}

/** What the full-screen viewer is showing. A [Gallery] target holds only an index and renders from
 * the LIVE `cards` list, so a re-push updating a canvas is reflected while the viewer stays open. A
 * [Chip] target is a standalone exact file (a tapped chip), independent of the gallery. */
private sealed interface ViewerTarget {
	data class Gallery(val index: Int) : ViewerTarget

	data class Chip(val card: DesignerCard) : ViewerTarget
}

////////////////////////////////
//  Composables

/**
 * The Designer dock: a fixed bar above the composer listing the latest of each canvas, expanding
 * into a gallery, each opening full-screen with a per-card action set. It ALSO hosts the viewer for
 * a card-marked attachment chip tapped in the chat body (which opens that exact file), so the dock
 * composes even when the gallery is empty. Version history is intentionally absent - an older
 * revision is an earlier chat message, reached by tapping its chip.
 */
@Composable
fun DesignerDock(scope: ThreadDockScope) {
	val team = scope.team
	val context = LocalContext.current
	val repo = remember { Repo.get(context) }
	val filesDir = context.filesDir

	// Render straight from the additive store. The inbound pipeline ingests each NEW dsCard exactly
	// once (DesignerPlugin's `inboundMessages` handler), so the dock never re-scans the thread. The
	// only history the pipeline missed is what arrived before the plugin existed: a one-time per-team
	// backfill seeds those, then the flag is set and it never scans again.
	androidx.compose.runtime.LaunchedEffect(team) {
		if (DesignStore.hasBackfilled(team)) return@LaunchedEffect
		// Wait for the thread to hydrate (first non-empty snapshot) before seeding, so a compose that
		// races thread load cannot mark an empty history backfilled and lose its old cards. A truly
		// empty thread just suspends here harmlessly until the dock leaves composition.
		val history = androidx.compose.runtime.snapshotFlow { repo.state.value.threads[team] ?: emptyList() }
			.first { it.isNotEmpty() }
		// Claim the flag BEFORE seeding, and seed uncancellably. Mark-first means a torn backfill (the
		// dock closes, or the process dies mid-loop) can only MISS some pre-plugin cards, never leave
		// the flag unset to re-seed a card the user has since deleted. NonCancellable lets an ordinary
		// tab switch still finish the seed it began rather than dropping the tail. Each seed is guarded
		// by the removal generation captured up front, so a Delete/Forget that races this loop wins:
		// once it bumps the generation, the remaining seeds drop instead of resurrecting a removed card.
		withContext(NonCancellable + Dispatchers.IO) {
			val guardGen = DesignStore.removalGeneration(team)
			DesignStore.markBackfilled(team)
			for (msg in history) {
				if (msg.fromMe || msg.isPeer) continue // agent-pushed content only, mirroring the ingest guard
				cardsFrom(msg.files, msg.at) { rel -> readCardPrefix(filesDir, rel) }
					.forEach { DesignStore.upsert(team, it, guardGen = guardGen) }
			}
		}
	}
	val stored by androidx.compose.runtime.key(team) { DesignStore.cards(team).collectAsState() }
	val cards = remember(stored) { stored.map { it.toCard() } }

	// State keyed by team: the dock is one composable instance reused across tab/session switches
	// (the scope changes, the instance does not), so unkeyed state would carry an open sheet or
	// canvas from one conversation into the next.
	var expanded by remember(team) { mutableStateOf(false) }
	var viewer by remember(team) { mutableStateOf<ViewerTarget?>(null) }

	// Chip-tap hand-off: a tap on a card-marked attachment in the chat body opens THAT EXACT file
	// here. Events (replay 0) never replay on re-entry; the exact card is built off the tapped rel,
	// independent of the gallery, so an old revision or a dock-deleted canvas still opens.
	var pendingOpenRel by remember(team) { mutableStateOf<String?>(null) }
	androidx.compose.runtime.LaunchedEffect(team) {
		DesignerOpenBus.events.collect { req -> if (req.team == team) pendingOpenRel = req.rel }
	}
	androidx.compose.runtime.LaunchedEffect(pendingOpenRel) {
		val rel = pendingOpenRel ?: return@LaunchedEffect
		// Read BEFORE clearing the key: nulling pendingOpenRel re-keys this effect, and doing that
		// ahead of the suspend would let a recomposition cancel the in-flight read and silently drop
		// the tap. If a newer tap changed pendingOpenRel while we were reading, this read is superseded:
		// leave the key set (its own effect processes the newer tap) and DO NOT open our now-stale card,
		// or a slower first read could clobber the newer tap's viewer. Latest tap wins.
		val card = withContext(Dispatchers.IO) { buildCardForRel(filesDir, rel) }
		if (pendingOpenRel != rel) return@LaunchedEffect
		pendingOpenRel = null
		if (card != null) {
			expanded = false
			viewer = ViewerTarget.Chip(card)
		}
	}

	// When the gallery empties (e.g. the last card deleted), close the sheet and any open gallery
	// viewer. Done in an effect, not during composition, to avoid a compositional state write. A
	// Chip viewer stays open - it shows a standalone tapped file, independent of the gallery.
	androidx.compose.runtime.LaunchedEffect(cards) {
		if (cards.isEmpty()) {
			expanded = false
			if (viewer is ViewerTarget.Gallery) viewer = null
		}
	}

	if (cards.isNotEmpty()) DockBar(cards) { expanded = true }
	if (expanded) {
		CanvasSheet(
			cards = cards,
			onOpen = {
				viewer = ViewerTarget.Gallery(it)
				expanded = false
			},
			onAction = { card, action -> runAction(context, scope, filesDir, card, action) {} },
			onDismiss = { expanded = false },
		)
	}
	viewer?.let { target ->
		// Gallery renders from LIVE cards (so a re-push reflects); chip renders its standalone card.
		val items = when (target) {
			is ViewerTarget.Gallery -> cards
			is ViewerTarget.Chip -> listOf(target.card)
		}
		val index = when (target) {
			is ViewerTarget.Gallery -> target.index
			is ViewerTarget.Chip -> 0
		}
		if (items.isNotEmpty()) {
			CanvasViewer(
				items = items,
				index = index.coerceIn(0, items.lastIndex),
				filesDir = filesDir,
				// Delete manages the dock GALLERY (remove this canvas). A Chip viewer shows a specific
				// historical file, not a gallery entry, so it omits Delete - deleting from there would
				// confusingly remove the CURRENT gallery card, not the file on screen.
				allowDelete = target is ViewerTarget.Gallery,
				onIndex = { viewer = ViewerTarget.Gallery(it) },
				onAction = { card, action ->
					runAction(context, scope, filesDir, card, action) {
						if (action == CardAction.DELETE) viewer = null
					}
				},
				onClose = { viewer = null },
			)
		}
	}
}

/** Execute one card action; [onChanged] fires for store-mutating actions so the caller re-derives. */
private fun runAction(
	context: Context,
	scope: ThreadDockScope,
	filesDir: File,
	card: DesignerCard,
	action: CardAction,
	onChanged: () -> Unit,
) {
	when (action) {
		CardAction.REFERENCE -> scope.insertDraftText("**${card.name}** ")
		CardAction.REATTACH -> cardFile(filesDir, card.rel)?.let { reattach(context, scope.team, it) }
		CardAction.DOWNLOAD -> {
			val ok = cardFile(filesDir, card.rel)?.let { saveFileToDownloads(context, it, card.fileName, "text/html") } ?: false
			Toast.makeText(context, if (ok) "Saved to Downloads" else "Couldn't save", Toast.LENGTH_SHORT).show()
		}
		CardAction.DELETE -> {
			// Remove from the additive index (the array shrinks). Deleting the pointer never touches the
			// message attachment; the pipeline delivered this card's message once and won't re-add it, so
			// only a strictly-newer re-push (a fresh inbound) brings the canvas back.
			DesignStore.delete(scope.team, card.fileName)
			onChanged()
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
			Text(
				listOfNotNull("updated ${shortTime(card.updatedAt)}", dims).joinToString("  "),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		Box {
			IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Canvas actions") }
			DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
				CardAction.entries.forEach { action ->
					DropdownMenuItem(text = { Text(action.label) }, onClick = {
						menuOpen = false
						onAction(action)
					})
				}
			}
		}
	}
}

@Composable
private fun CanvasViewer(
	items: List<DesignerCard>,
	index: Int,
	filesDir: File,
	allowDelete: Boolean,
	onIndex: (Int) -> Unit,
	onAction: (DesignerCard, CardAction) -> Unit,
	onClose: () -> Unit,
) {
	val context = LocalContext.current
	val card = items[index]
	var menuOpen by remember { mutableStateOf(false) }
	val actions = if (allowDelete) CardAction.entries else CardAction.entries.filter { it != CardAction.DELETE }
	// Produced value carries the rel it was read for: produceState keeps the prior value across a
	// key change until the new read lands, so the render gates on a match and never paints the
	// previous canvas under the new card's identity.
	val loaded by produceState<Pair<String, String>?>(initialValue = null, card.rel) {
		val text = withContext(Dispatchers.IO) { readCardHtml(filesDir, card.rel) }
		value = text?.let { card.rel to it }
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
					IconButton(onClick = { cardFile(filesDir, card.rel)?.let { shareCard(context, it) } }) {
						Icon(Icons.Default.Share, contentDescription = "Share canvas")
					}
					Box {
						IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Canvas actions") }
						DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
							actions.forEach { action ->
								DropdownMenuItem(text = { Text(action.label) }, onClick = {
									menuOpen = false
									onAction(card, action)
								})
							}
						}
					}
				}
				Box(Modifier.weight(1f).fillMaxWidth()) {
					val match = loaded?.takeIf { it.first == card.rel }
					if (match != null) {
						AndroidView(
							factory = { ctx -> sandboxedCardWebView(ctx) },
							update = { wv ->
								if (wv.tag != card.rel) {
									wv.tag = card.rel
									wv.loadDataWithBaseURL(null, match.second, "text/html", "utf-8", null)
								}
							},
							onRelease = { it.destroy() },
							modifier = Modifier.fillMaxSize(),
						)
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
