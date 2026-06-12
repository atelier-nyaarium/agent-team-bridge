package com.atelier_nyaarium.switchboard

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.launch

/** Process-lifetime repository so chat state survives Activity recreation. */
object Repo {
	@Volatile private var instance: ChatRepository? = null

	fun get(context: Context): ChatRepository =
		instance ?: synchronized(this) {
			val app = context.applicationContext
			instance ?: ChatRepository(
				ProvisioningStore(app),
				app.filesDir,
				app.contentResolver,
				loadSttsCatalog(app),
			).also { instance = it }
		}

	/** Parse the bundled STTS provider catalog once. A corrupt/missing asset
	 * yields an empty catalog, which keeps Play dark rather than crashing. */
	private fun loadSttsCatalog(app: Context): List<com.atelier_nyaarium.switchboard.proto.SttsProvider> =
		runCatching {
			val json = app.assets.open("stts-providers.json").bufferedReader().use { it.readText() }
			kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
				.decodeFromString<com.atelier_nyaarium.switchboard.proto.SttsProviders>(json)
				.providers
		}.getOrDefault(emptyList())
}

// FragmentActivity (not ComponentActivity) so androidx.biometric can attach its prompt.
class MainActivity : FragmentActivity() {
	/** Team a notification tap asked to open; consumed by App, refreshed by onNewIntent. */
	private val openTeamRequest = mutableStateOf<String?>(null)

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val repo = Repo.get(this)
		val injected = intent.getStringExtra("provisioning_b64")
			?.let { runCatching { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }.getOrNull() }
		openTeamRequest.value = intent.getStringExtra(SwitchboardService.EXTRA_OPEN_TEAM)
		setContent {
			val colors = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
			MaterialTheme(colorScheme = colors) { App(repo, injected, openTeamRequest) }
		}
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		intent.getStringExtra(SwitchboardService.EXTRA_OPEN_TEAM)?.let { openTeamRequest.value = it }
	}
}

@Composable
fun App(repo: ChatRepository, injectedBlob: String?, openTeamRequest: MutableState<String?>) {
	val state by repo.state.collectAsState()
	val scope = rememberCoroutineScope()
	val context = LocalContext.current
	val activity = context as? FragmentActivity
	var openTeam by remember { mutableStateOf<String?>(null) }
	var showSettings by remember { mutableStateOf(false) }
	var unlocked by remember { mutableStateOf(false) }

	// WebView pool lives at App scope (never leaves composition) so each thread's
	// renderer survives Sessions round-trips and tab switches. Pruned to open tabs;
	// destroyed with the Activity.
	val rendererPool = remember { ThreadRendererPool(context.applicationContext) }
	rendererPool.onRetry = { team, id ->
		// The demo fixture's error row must never reach the real repository.
		if (!(BuildConfig.DEBUG && team == DEMO_TEAM)) scope.launch { repo.retrySend(team, id) }
	}
	// Attachment taps open the in-app viewer; the path is re-validated against the
	// attachments root before any file is touched. The wire mime (what the agent
	// declared) is preferred over extension guessing.
	var viewer by remember { mutableStateOf<OpenAttachment?>(null) }
	rendererPool.onAttachmentTap = { rel ->
		Attachments.resolve(context.filesDir, rel)?.let { file ->
			val wireMime = state.threads.values.asSequence().flatten()
				.flatMap { it.files.asSequence() }
				.firstOrNull { it.src?.endsWith("/$rel") == true }
				?.mime?.takeIf { it.isNotEmpty() }
			viewer = OpenAttachment(file, file.name, wireMime ?: mimeForFile(file), rel)
		}
	}
	// In-thread Play: buttons render only when STTS is provisioned; taps speak
	// the full tier, and the player's now-playing pushes glyph state back.
	// Re-evaluated per recomposition (cheap cached null-check) so provisioning
	// in-session lights the buttons for renderers built afterward; a thread
	// already open gains them on its next (re)open rather than never.
	rendererPool.playEnabled = repo.sttsReady()
	rendererPool.onPlayTap = { team, at -> repo.playMessage(team, at, SttsPlayer.Tier.FULL) }
	DisposableEffect(Unit) {
		// Fires on the player's daemon thread; the pool's renderer map is
		// main-owned, so hop through the composition scope (main-dispatched).
		repo.stts.onPlayingChanged = { team, at, playing ->
			scope.launch { rendererPool.setPlaying(team, if (playing) at else null) }
		}
		onDispose { repo.stts.onPlayingChanged = null }
	}
	val dark = isSystemInDarkTheme()
	LaunchedEffect(dark) { rendererPool.setDark(dark) }
	LaunchedEffect(state.openTabs) { rendererPool.retain(state.openTabs.toSet()) }
	DisposableEffect(Unit) { onDispose { rendererPool.destroyAll() } }

	LaunchedEffect(injectedBlob) {
		if (injectedBlob != null && !state.provisioned) repo.provision(injectedBlob)
	}
	// The service owns the connection and poll loop; the Activity just makes sure
	// it is running and asks for notification permission once provisioned.
	val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
	LaunchedEffect(state.provisioned) {
		if (state.provisioned) {
			SwitchboardService.start(context)
			if (
				android.os.Build.VERSION.SDK_INT >= 33 &&
				context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
				android.content.pm.PackageManager.PERMISSION_GRANTED
			) {
				notifPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
			}
		}
	}
	// Visibility drives the poll cadence; a foreground transition also kicks an
	// immediate poll and reconciles any sends stranded mid-flight.
	val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
	DisposableEffect(lifecycleOwner) {
		val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
			when (event) {
				androidx.lifecycle.Lifecycle.Event.ON_START -> {
					repo.onForeground()
					scope.launch { repo.reconcilePending() }
				}
				androidx.lifecycle.Lifecycle.Event.ON_STOP -> repo.onBackground()
				else -> {}
			}
		}
		lifecycleOwner.lifecycle.addObserver(observer)
		onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
	}
	// A notification tap routes straight to its thread.
	LaunchedEffect(openTeamRequest.value) {
		openTeamRequest.value?.let { team ->
			repo.openThread(team)
			openTeam = team
			openTeamRequest.value = null
		}
	}
	// Reading a thread clears its bar notification no matter how it was opened
	// (session card, notification tap, or tab) - the bar mirrors unread state.
	LaunchedEffect(openTeam) {
		openTeam?.let { SwitchboardService.cancelTeamNotification(context, it) }
	}

	val locked = state.provisioned && state.biometricLock && !unlocked
	LaunchedEffect(locked) {
		if (locked && activity != null) promptUnlock(activity) { ok -> if (ok) unlocked = true }
	}

	// System back navigates within the app (thread/settings -> sessions) instead of exiting.
	BackHandler(enabled = openTeam != null || showSettings) {
		when {
			openTeam != null -> openTeam = null
			showSettings -> showSettings = false
		}
	}

	when {
		!state.provisioned -> ProvisionScreen(onProvision = { scope.launch { repo.provision(it) } })
		locked -> LockScreen(onUnlock = { activity?.let { a -> promptUnlock(a) { ok -> if (ok) unlocked = true } } })
		showSettings ->
			SettingsScreen(
				state = state,
				repo = repo,
				onSetDeviceName = { scope.launch { repo.setDeviceName(it) } },
				onToggleBiometric = { repo.setBiometricLock(it) },
				onClear = {
					scope.launch { repo.clearAll() }
					showSettings = false
					openTeam = null
				},
				onBack = { showSettings = false },
			)
		openTeam != null -> {
			// The demo session renders through the same Thread pipeline but is fed an
			// in-memory fixture and is read-only, so it never reaches the persisted store.
			// Gated on DEBUG so a real peer named "demo" in a release build shows its own
			// thread, not the fixture.
			val isDemo = BuildConfig.DEBUG && openTeam == DEMO_TEAM
			// Devcontainer names are the project identity; only loose peers take labels.
			val session = state.sessions.firstOrNull { it.name == openTeam }
			val kind = session?.kind
			// Rename only when positively known loose; an unknown kind (team gone
			// from the list) stays un-renameable rather than defaulting open.
			val presence = when {
				isDemo || session == null -> null
				session.status == "online" -> if (state.working(session.name)) "working..." else "live"
				session.status == "available" -> if (state.working(session.name)) "waking..." else "available"
				else -> "ended"
			}
			ThreadScreen(
				team = openTeam!!,
				label = state.label(openTeam!!),
				presence = presence,
				tabs = state.openTabs,
				tabLabel = { state.label(it) },
				messages = if (isDemo) demoMessages() else state.threads[openTeam].orEmpty(),
				error = state.error,
				rendererPool = rendererPool,
				canRename = !isDemo && kind == "loose",
				onSwitch = { openTeam = it },
				onCloseTab = { t ->
					// Move off the closing tab before dropping it from openTabs, so the
					// retain() pass that destroys its renderer never targets the one
					// still on screen.
					if (t == openTeam) openTeam = state.openTabs.firstOrNull { it != t }
					repo.closeTab(t)
				},
				onSessions = { openTeam = null },
				onSend = { text, uris -> if (!isDemo) scope.launch { repo.send(openTeam!!, text, uris) } },
				onRename = { name -> if (!isDemo) repo.setLabel(openTeam!!, name) },
				onForget = {
					val t = openTeam!!
					if (!isDemo) repo.forget(t) else repo.closeTab(t)
					openTeam = null
				},
			)
		}
		else ->
			SessionsScreen(
				state = state,
				showDemo = BuildConfig.DEBUG,
				onRefresh = { scope.launch { repo.refreshTeams() } },
				onSettings = { showSettings = true },
				onOpen = { team ->
					repo.openThread(team)
					openTeam = team
					SwitchboardService.cancelTeamNotification(context, team)
				},
				onRename = { team, name -> repo.setLabel(team, name) },
				onForget = { team -> repo.forget(team) },
			)
	}

	// Composed after the screens so it overlays them and its BackHandler wins.
	viewer?.let { att ->
		AttachmentViewer(
			att = att,
			onOpenWith = {
				rendererPool.openWith(att.relPath)
				viewer = null
			},
			onDismiss = { viewer = null },
		)
	}
}

@Composable
fun LockScreen(onUnlock: () -> Unit) {
	Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
		Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
			Text("Switchboard is locked", style = MaterialTheme.typography.titleLarge)
			Button(onClick = onUnlock) { Text("Unlock") }
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProvisionScreen(onProvision: (String) -> Unit) {
	val context = LocalContext.current
	var status by remember { mutableStateOf("") }

	fun tryProvision(text: String?, source: String) {
		val s = text?.trim().orEmpty()
		if (looksProvisionable(s)) {
			status = "Connecting..."
			onProvision(s)
		} else {
			status = "$source did not contain provisioning JSON."
		}
	}

	// SAF file picker. arrayOf("*/*") so a .json with any reported MIME type is selectable.
	val fileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
		if (uri == null) return@rememberLauncherForActivityResult
		val text = runCatching {
			context.contentResolver.openInputStream(uri)?.use { it.readBytes().decodeToString() }
		}.getOrNull()
		tryProvision(text, "File")
	}

	Scaffold(topBar = { TopAppBar(title = { Text("Provision Switchboard") }) }) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize(),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			Text("Load the provisioning blob the host generated for you.")
			Button(
				onClick = { tryProvision(readClipboard(context), "Clipboard") },
				modifier = Modifier.fillMaxWidth(),
			) { Text("Paste from clipboard") }
			Button(
				onClick = { fileLauncher.launch(arrayOf("*/*")) },
				modifier = Modifier.fillMaxWidth(),
			) { Text("Import from file") }
			if (status.isNotEmpty()) {
				val color =
					if (status.startsWith("Connecting")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
				Text(status, color = color)
			}
		}
	}
}

private fun readClipboard(context: Context): String? {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
	return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
}

/** True once the text is a JSON object with the fields a Provisioning needs. */
private fun looksProvisionable(s: String): Boolean = runCatching {
	val j = org.json.JSONObject(s.trim())
	j.has("apiUrl") && j.has("saToken") && j.has("caPem")
}.getOrDefault(false)

/** Live first, then most recent activity, then name, within each section. */
private fun sessionOrder(state: ChatState): Comparator<Team> =
	compareByDescending<Team> { it.status == "online" }
		.thenByDescending { state.lastActivity(it.name) ?: 0L }
		.thenBy { it.name }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
	state: ChatState,
	showDemo: Boolean,
	onRefresh: () -> Unit,
	onSettings: () -> Unit,
	onOpen: (String) -> Unit,
	onRename: (String, String) -> Unit,
	onForget: (String) -> Unit,
) {
	// Long-press flow: action menu -> rename dialog or forget confirm.
	var actionTeam by remember { mutableStateOf<Team?>(null) }
	var renameTeam by remember { mutableStateOf<Team?>(null) }
	var forgetTeam by remember { mutableStateOf<Team?>(null) }

	actionTeam?.let { team ->
		SessionActionsDialog(
			label = state.label(team.name),
			canRename = team.kind != "devcontainer",
			onRename = {
				actionTeam = null
				renameTeam = team
			},
			onForget = {
				actionTeam = null
				forgetTeam = team
			},
			onDismiss = { actionTeam = null },
		)
	}
	renameTeam?.let { team ->
		RenameDialog(
			team = team.name,
			current = state.label(team.name),
			onSave = {
				onRename(team.name, it)
				renameTeam = null
			},
			onDismiss = { renameTeam = null },
		)
	}
	forgetTeam?.let { team ->
		ConfirmDialog(
			title = "Forget ${state.label(team.name)}?",
			body = "Drops this thread, its label, and unread state from this device.",
			confirmText = "Forget",
			onConfirm = {
				onForget(team.name)
				forgetTeam = null
			},
			onDismiss = { forgetTeam = null },
		)
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Agent Sessions") },
				actions = {
					TextButton(onClick = onRefresh) { Text("Refresh") }
					TextButton(onClick = onSettings) { Text("Settings") }
				},
			)
		},
	) { pad ->
		Column(Modifier.padding(pad).fillMaxSize()) {
			HealthHeader(state)
			if (state.gap) {
				Surface(
					color = MaterialTheme.colorScheme.errorContainer,
					modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
					shape = MaterialTheme.shapes.medium,
				) {
					Text(
						"Some messages were dropped (mailbox overflow). Pull history from the host to recover.",
						Modifier.padding(12.dp),
						color = MaterialTheme.colorScheme.onErrorContainer,
						style = MaterialTheme.typography.bodySmall,
					)
				}
			}
			if (state.sessions.isEmpty() && !showDemo) {
				if (!state.connected) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
				Text(
					state.error ?: state.status.ifEmpty { "Connecting..." },
					Modifier.padding(16.dp),
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			val order = sessionOrder(state)
			val projects = state.sessions.filter { it.kind == "devcontainer" }.sortedWith(order)
			val windows = state.sessions.filter { it.kind != "devcontainer" }.sortedWith(order)
			LazyColumn(
				Modifier.fillMaxSize(),
				contentPadding = PaddingValues(12.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp),
			) {
				// Keys are namespaced so a team literally named "hdr-projects" or
				// "demo" cannot collide with the header/demo items.
				if (projects.isNotEmpty()) {
					item(key = "hdr-projects") { SectionLabel("Projects") }
					items(projects, key = { "team:${it.name}" }) { team ->
						SessionCard(
							state = state,
							team = team,
							onClick = { onOpen(team.name) },
							onLongPress = { actionTeam = team },
						)
					}
				}
				if (windows.isNotEmpty()) {
					item(key = "hdr-windows") { SectionLabel("Windows") }
					items(windows, key = { "team:${it.name}" }) { team ->
						SessionCard(
							state = state,
							team = team,
							onClick = { onOpen(team.name) },
							onLongPress = { actionTeam = team },
						)
					}
				}
				if (showDemo) {
					item(key = "card-demo") { DemoCard(onClick = { onOpen(DEMO_TEAM) }) }
				}
			}
		}
	}
}

@Composable
fun HealthHeader(state: ChatState) {
	val (dot, label) = when (state.health) {
		ChatState.Health.ONLINE -> Color(0xFF2EA043) to "Bridge online"
		ChatState.Health.DEGRADED -> Color(0xFFD29922) to "Reconnecting..."
		ChatState.Health.OFFLINE -> Color(0xFFCF222E) to "Offline"
	}
	Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
			Spacer(Modifier.width(8.dp))
			Text(label, style = MaterialTheme.typography.labelLarge)
			Spacer(Modifier.weight(1f))
			if (state.deviceName.isNotEmpty()) {
				Text(
					state.deviceName,
					style = MaterialTheme.typography.labelMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					fontFamily = FontFamily.Monospace,
				)
			}
		}
	}
}

/** Chip color for the board/thread presence vocabulary. */
@Composable
private fun presenceColor(presence: String): Color = when (presence) {
	"live" -> Color(0xFF2EA043)
	"working...", "waking..." -> Color(0xFFD29922)
	"available" -> Color(0xFF0969DA)
	else -> MaterialTheme.colorScheme.outline
}

@Composable
private fun StatusChip(text: String, color: Color) {
	Surface(color = color.copy(alpha = 0.16f), shape = MaterialTheme.shapes.small) {
		Row(Modifier.padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
			Box(Modifier.size(7.dp).clip(CircleShape).background(color))
			Spacer(Modifier.width(5.dp))
			Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurface)
		}
	}
}

@Composable
fun SectionLabel(text: String) {
	Text(
		text.uppercase(),
		style = MaterialTheme.typography.labelSmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
		letterSpacing = androidx.compose.ui.unit.TextUnit(1.5f, androidx.compose.ui.unit.TextUnitType.Sp),
		modifier = Modifier.padding(start = 4.dp, top = 8.dp, bottom = 2.dp),
	)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionCard(state: ChatState, team: Team, onClick: () -> Unit, onLongPress: () -> Unit) {
	val display = state.label(team.name)
	val unread = state.unread[team.name] ?: 0
	val live = team.status == "online"
	val isCli = team.mode == "cli"
	// Wire vocabulary -> board vocabulary: online teams are live, catalog teams are
	// available (wakeable), anything else is an ended loose session.
	val (statusWord, statusColor) = when {
		live -> "live" to Color(0xFF2EA043)
		team.status == "available" -> "available" to Color(0xFF0969DA)
		else -> "ended" to MaterialTheme.colorScheme.outline
	}
	// Long-press stays enabled for CLI cards: the action sheet's Forget is the only
	// way to clear their local thread state. Only opening (tap) is gated off. The
	// clip keeps the ripple inside the card's rounded corners.
	Card(
		modifier = Modifier.fillMaxWidth().clip(CardDefaults.shape).combinedClickable(
			onClick = { if (!isCli) onClick() },
			onLongClick = onLongPress,
		),
	) {
		Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically) {
				Text(
					display,
					style = MaterialTheme.typography.titleMedium,
					fontFamily = FontFamily.Monospace,
					modifier = Modifier.weight(1f),
				)
				if (unread > 0) Badge { Text("$unread") }
			}
			if (display != team.name) {
				Text(
					team.name,
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					fontFamily = FontFamily.Monospace,
				)
			}
			Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
				StatusChip(statusWord, statusColor)
				if (live && state.working(team.name)) StatusChip("working...", Color(0xFFD29922))
				if (isCli) StatusChip("cli", MaterialTheme.colorScheme.outline)
				Spacer(Modifier.weight(1f))
				state.lastActivity(team.name)?.let {
					Text(
						relativeTime(it),
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			}
			if (isCli) {
				Text(
					"CLI agent - phone chat is not supported",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			state.snippet(team.name)?.let {
				Text(
					it,
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					maxLines = 1,
					overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
				)
			}
		}
	}
}

@Composable
fun SessionActionsDialog(
	label: String,
	canRename: Boolean,
	onRename: () -> Unit,
	onForget: () -> Unit,
	onDismiss: () -> Unit,
) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(label, fontFamily = FontFamily.Monospace) },
		text = {
			Column {
				if (canRename) {
					TextButton(onClick = onRename, modifier = Modifier.fillMaxWidth()) { Text("Rename") }
				} else {
					Text(
						"Project names come from the host and cannot be renamed.",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				TextButton(onClick = onForget, modifier = Modifier.fillMaxWidth()) { Text("Forget...") }
			}
		},
		confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
	)
}

@Composable
fun ConfirmDialog(title: String, body: String, confirmText: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(title) },
		text = { Text(body) },
		confirmButton = { TextButton(onClick = onConfirm) { Text(confirmText) } },
		dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
	)
}

@Composable
fun DemoCard(onClick: () -> Unit) {
	Card(
		onClick = onClick,
		modifier = Modifier.fillMaxWidth(),
		colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
	) {
		Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
			Column(Modifier.weight(1f)) {
				Text("Render demo", style = MaterialTheme.typography.titleMedium)
				Text(
					"markdown matrix, debug build only",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSecondaryContainer,
				)
			}
			Badge(containerColor = MaterialTheme.colorScheme.secondary) { Text("demo") }
		}
	}
}

/** Compact relative time for the session cards: now, 5m, 3h, 2d, else a date. */
private fun relativeTime(at: Long): String {
	val delta = System.currentTimeMillis() - at
	return when {
		delta < 60_000 -> "now"
		delta < 3_600_000 -> "${delta / 60_000}m"
		delta < 86_400_000 -> "${delta / 3_600_000}h"
		delta < 604_800_000 -> "${delta / 86_400_000}d"
		else -> java.text.SimpleDateFormat("MMM d", java.util.Locale.getDefault()).format(java.util.Date(at))
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadScreen(
	team: String,
	label: String,
	presence: String?,
	tabs: List<String>,
	tabLabel: (String) -> String,
	messages: List<Message>,
	error: String?,
	rendererPool: ThreadRendererPool,
	canRename: Boolean,
	onSwitch: (String) -> Unit,
	onCloseTab: (String) -> Unit,
	onSessions: () -> Unit,
	onSend: (String, List<Uri>) -> Unit,
	onRename: (String) -> Unit,
	onForget: () -> Unit,
) {
	var draft by remember { mutableStateOf("") }
	var showMenu by remember { mutableStateOf(false) }
	var showRename by remember { mutableStateOf(false) }
	var confirmForget by remember { mutableStateOf(false) }
	var attachments by remember { mutableStateOf<List<Uri>>(emptyList()) }
	val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
		if (uris.isNotEmpty()) attachments = attachments + uris
	}

	if (showRename) {
		RenameDialog(
			team = team,
			current = label,
			onSave = {
				onRename(it)
				showRename = false
			},
			onDismiss = { showRename = false },
		)
	}
	if (confirmForget) {
		ConfirmDialog(
			title = "Forget $label?",
			body = "Drops this thread, its label, and unread state from this device.",
			confirmText = "Forget",
			onConfirm = {
				confirmForget = false
				onForget()
			},
			onDismiss = { confirmForget = false },
		)
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = {
					Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
						Text(
							label,
							fontFamily = FontFamily.Monospace,
							maxLines = 1,
							overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
							modifier = Modifier.weight(1f, fill = false),
						)
						presence?.let { StatusChip(it, presenceColor(it)) }
					}
				},
				navigationIcon = { TextButton(onClick = onSessions) { Text("Sessions") } },
				actions = {
					IconButton(onClick = { showMenu = true }) { Text("⋮", style = MaterialTheme.typography.titleLarge) }
					DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
						if (canRename) {
							DropdownMenuItem(
								text = { Text("Rename") },
								onClick = {
									showMenu = false
									showRename = true
								},
							)
						}
						DropdownMenuItem(
							text = { Text("Close tab") },
							onClick = {
								showMenu = false
								onCloseTab(team)
							},
						)
						DropdownMenuItem(
							text = { Text("Forget...") },
							onClick = {
								showMenu = false
								confirmForget = true
							},
						)
					}
				},
			)
		},
	) { pad ->
		// imePadding keeps the composer above the keyboard (adjustResize alone does
		// not resize a Compose window on modern Android).
		Column(Modifier.padding(pad).fillMaxSize().imePadding()) {
			if (tabs.size > 1) {
				val selected = tabs.indexOf(team).coerceAtLeast(0)
				ScrollableTabRow(selectedTabIndex = selected, edgePadding = 8.dp) {
					tabs.forEachIndexed { i, t ->
						Tab(selected = i == selected, onClick = { onSwitch(t) }, text = { Text(tabLabel(t)) })
					}
				}
			}
			if (messages.isEmpty()) {
				Column(
					Modifier.weight(1f).fillMaxWidth().padding(32.dp),
					verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
					horizontalAlignment = Alignment.CenterHorizontally,
				) {
					Text(label, style = MaterialTheme.typography.titleLarge, fontFamily = FontFamily.Monospace)
					Text(
						when (presence) {
							"available", "waking..." ->
								"No messages yet. Sending will wake $label - first boot can take a minute or two."
							"live", "working..." -> "No messages yet. $label is live."
							"ended" -> "This session has ended."
							else -> "No messages yet."
						},
						style = MaterialTheme.typography.bodyMedium,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
						textAlign = androidx.compose.ui.text.style.TextAlign.Center,
					)
				}
			} else {
				ThreadWebView(
					team = team,
					messages = messages,
					rendererPool = rendererPool,
					modifier = Modifier.weight(1f).fillMaxWidth(),
				)
			}
			if (error != null) Text(error, Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.error)
			if (attachments.isNotEmpty()) {
				Row(
					Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 4.dp),
					horizontalArrangement = Arrangement.spacedBy(6.dp),
				) {
					attachments.forEach { uri ->
						Surface(
							color = MaterialTheme.colorScheme.surfaceVariant,
							shape = MaterialTheme.shapes.small,
						) {
							Row(
								Modifier.padding(start = 10.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
								verticalAlignment = Alignment.CenterVertically,
							) {
								Text(
									uri.lastPathSegment?.substringAfterLast('/') ?: "file",
									style = MaterialTheme.typography.labelSmall,
									maxLines = 1,
									overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
									modifier = Modifier.widthIn(max = 120.dp),
								)
								TextButton(
									onClick = { attachments = attachments - uri },
									contentPadding = PaddingValues(horizontal = 4.dp),
								) { Text("x") }
							}
						}
					}
				}
			}
			Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
				TextButton(onClick = { picker.launch(arrayOf("*/*")) }) { Text("Attach") }
				OutlinedTextField(
					value = draft,
					onValueChange = { draft = it },
					label = { Text("Message") },
					modifier = Modifier.weight(1f),
				)
				Button(
					enabled = draft.isNotBlank() || attachments.isNotEmpty(),
					onClick = {
						onSend(draft, attachments)
						draft = ""
						attachments = emptyList()
					},
					modifier = Modifier.padding(start = 8.dp),
				) { Text("Send") }
			}
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
	state: ChatState,
	repo: ChatRepository,
	onSetDeviceName: (String) -> Unit,
	onToggleBiometric: (Boolean) -> Unit,
	onClear: () -> Unit,
	onBack: () -> Unit,
) {
	var name by remember { mutableStateOf(state.deviceName) }
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Settings") },
				navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
			)
		},
	) { pad ->
		Column(
			// Scrollable: the settings list outgrew one screen once the voice
			// playback section landed.
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			Text("Device name", style = MaterialTheme.typography.titleMedium)
			Row(verticalAlignment = Alignment.CenterVertically) {
				OutlinedTextField(value = name, onValueChange = { name = it }, modifier = Modifier.weight(1f))
				Button(
					enabled = name.isNotBlank() && name != state.deviceName,
					onClick = { onSetDeviceName(name.trim()) },
					modifier = Modifier.padding(start = 8.dp),
				) { Text("Save") }
			}

			HorizontalDivider()
			Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
				Text("Biometric lock", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
				Switch(checked = state.biometricLock, onCheckedChange = onToggleBiometric)
			}
			Text(
				"Require fingerprint or device PIN on app open. Falls back to unlocked if nothing is enrolled.",
				style = MaterialTheme.typography.bodySmall,
			)

			HorizontalDivider()
			BatteryExemptionRow()

			if (repo.sttsReady()) {
				HorizontalDivider()
				SttsVoiceSection(repo)
			}

			HorizontalDivider()
			AppUpdateRow()

			HorizontalDivider()
			Spacer(Modifier.width(0.dp))
			Button(onClick = onClear) { Text("Clear & re-provision") }
			Text("Removes the stored credential and chat history from this device.", style = MaterialTheme.typography.bodySmall)
		}
	}
}

/** Voice settings for message playback: provider picker, voice identifier,
 * an audible sample preview, and a service liveness line. Values persist in
 * prefs (not the credential blob) through the repository. */
@Composable
private fun SttsVoiceSection(repo: ChatRepository) {
	val providers = remember { repo.sttsProviders() }
	var providerId by remember { mutableStateOf(repo.sttsProviderId) }
	val current = providers.firstOrNull { it.id == providerId }
	var voice by remember(providerId) { mutableStateOf(repo.sttsVoiceFor(providerId)) }
	var pickerOpen by remember { mutableStateOf(false) }
	var healthy by remember { mutableStateOf<Boolean?>(null) }
	var sampleError by remember { mutableStateOf<String?>(null) }
	LaunchedEffect(Unit) { healthy = repo.sttsHealth() }
	// Failed previews surface here instead of dead-ending in the log (snapshot
	// state writes are thread-safe, so the player thread can set it directly).
	DisposableEffect(Unit) {
		repo.stts.onPlaybackError = { reason -> sampleError = reason }
		onDispose { repo.stts.onPlaybackError = null }
	}

	Text("Voice playback", style = MaterialTheme.typography.titleMedium)
	Text(
		when (healthy) {
			null -> "Checking speech service..."
			true -> "Speech service online"
			false -> "Speech service unreachable"
		},
		style = MaterialTheme.typography.bodySmall,
	)
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedButton(onClick = { pickerOpen = true }) { Text(current?.label ?: providerId.ifEmpty { "Provider" }) }
		OutlinedTextField(
			value = voice,
			onValueChange = {
				voice = it
				repo.setSttsVoiceFor(providerId, it)
			},
			label = { Text(current?.voiceHint?.let { "$it (blank = default)" } ?: "Voice (blank = default)") },
			modifier = Modifier.weight(1f).padding(start = 8.dp),
			singleLine = true,
		)
	}
	current?.note?.let {
		Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}
	if (current?.voices?.isNotEmpty() == true) {
		Text(
			"Suggested: " + current.voices.joinToString(", ") { it.label ?: it.id },
			style = MaterialTheme.typography.bodySmall,
		)
	}
	Button(
		enabled = healthy == true && current != null,
		onClick = {
			sampleError = null
			repo.playSttsSample()
		},
	) { Text("Play a sample") }
	sampleError?.let {
		Text("Playback failed: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}

	if (pickerOpen) {
		AlertDialog(
			onDismissRequest = { pickerOpen = false },
			confirmButton = {},
			title = { Text("Provider") },
			text = {
				Column {
					for (p in providers) {
						TextButton(onClick = {
							providerId = p.id
							repo.sttsProviderId = p.id
							voice = repo.sttsVoiceFor(p.id)
							pickerOpen = false
						}) { Text(p.label) }
					}
				}
			},
		)
	}
}

/** One-press self-update: download the latest APK straight from the public
 * GitHub release, then launch the installer if it is newer than this build. */
@Composable
private fun AppUpdateRow() {
	val context = LocalContext.current
	val scope = rememberCoroutineScope()
	var status by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Column(Modifier.weight(1f)) {
			Text("App update", style = MaterialTheme.typography.titleMedium)
			Text(
				"v${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		Button(
			enabled = !busy,
			onClick = {
				busy = true
				status = "Checking for updates..."
				scope.launch(kotlinx.coroutines.Dispatchers.IO) {
					val result = AppUpdater.downloadAndStage(context)
					kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
						when (result) {
							is AppUpdater.Result.Newer -> {
								status = "Installing v${result.versionName ?: "?"} (build ${result.versionCode})..."
								AppUpdater.install(context)
							}
							AppUpdater.Result.UpToDate -> status = "Already up to date."
							is AppUpdater.Result.Failed -> status = result.message
						}
						busy = false
					}
				}
			},
		) { Text(if (busy) "..." else "Update") }
	}
	Text(
		status.ifEmpty { "Downloads and installs the latest APK from the GitHub release." },
		style = MaterialTheme.typography.bodySmall,
	)
}

/** Deep doze cuts network even for a foreground service; screen-off delivery
 * needs the battery-optimization exemption, which a sideloaded app may simply
 * request. The state re-checks on resume (the system dialog is another activity). */
@Composable
private fun BatteryExemptionRow() {
	val context = LocalContext.current
	val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
	var exempt by remember { mutableStateOf(pm.isIgnoringBatteryOptimizations(context.packageName)) }
	val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
	DisposableEffect(lifecycleOwner) {
		val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
			if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
				exempt = pm.isIgnoringBatteryOptimizations(context.packageName)
			}
		}
		lifecycleOwner.lifecycle.addObserver(observer)
		onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
	}
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text("Background delivery", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
		if (exempt) {
			Text("Allowed", color = MaterialTheme.colorScheme.primary)
		} else {
			Button(onClick = {
				runCatching {
					context.startActivity(
						Intent(
							android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
							Uri.parse("package:${context.packageName}"),
						),
					)
				}
			}) { Text("Allow") }
		}
	}
	Text(
		"Exempts the app from battery optimization so messages keep arriving while the screen is off.",
		style = MaterialTheme.typography.bodySmall,
	)
}

@Composable
fun RenameDialog(team: String, current: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
	var name by remember { mutableStateOf(if (current == team) "" else current) }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("Rename session") },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
				Text("Id: $team", style = MaterialTheme.typography.bodySmall)
				OutlinedTextField(
					value = name,
					onValueChange = { name = it },
					label = { Text("Display name") },
					singleLine = true,
				)
			}
		},
		confirmButton = { TextButton(onClick = { onSave(name) }) { Text("Save") } },
		dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
	)
}

/**
 * Hosts a thread's pooled WebView inside a FrameLayout. The renderer is pulled from
 * the pool (so scroll position and rendered DOM survive tab switches and Sessions
 * round-trips) and re-fed incrementally via sync(). A crashed renderer is swapped
 * for a fresh one and re-fed.
 */
@Composable
fun ThreadWebView(team: String, messages: List<Message>, rendererPool: ThreadRendererPool, modifier: Modifier) {
	var renderer by remember(team) { mutableStateOf(rendererPool.get(team)) }

	DisposableEffect(renderer) {
		renderer.onRendererGone = { renderer = rendererPool.recreate(team) }
		onDispose { renderer.onRendererGone = null }
	}
	LaunchedEffect(renderer, messages) { renderer.sync(messages) }

	AndroidView(
		factory = { ctx -> FrameLayout(ctx) },
		update = { frame ->
			val wv = renderer.webView
			if (wv.parent !== frame) {
				(wv.parent as? ViewGroup)?.removeView(wv)
				frame.removeAllViews()
				frame.addView(
					wv,
					FrameLayout.LayoutParams(
						FrameLayout.LayoutParams.MATCH_PARENT,
						FrameLayout.LayoutParams.MATCH_PARENT,
					),
				)
			}
		},
		modifier = modifier,
	)
}
