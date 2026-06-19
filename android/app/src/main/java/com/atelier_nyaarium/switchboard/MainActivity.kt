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
import androidx.compose.foundation.layout.height
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
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.Surface
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.PrimaryScrollableTabRow
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
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
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
		DebugLog.init(this)
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
	// Settings nav survives a config change (rotate / theme flip) so the open sub-screen is not
	// lost two levels deep; the route enum is Serializable (so rememberSaveable bundles it).
	var showSettings by rememberSaveable { mutableStateOf(false) }
	var settingsRoute by rememberSaveable { mutableStateOf(SettingsRoute.HUB) }
	var showManage by remember { mutableStateOf(false) }
	var showAddGateway by remember { mutableStateOf(false) }
	var unlocked by remember { mutableStateOf(false) }

	// WebView pool lives at App scope (never leaves composition) so each thread's
	// renderer survives Sessions round-trips and tab switches. Pruned to open tabs;
	// destroyed with the Activity.
	val rendererPool = remember { ThreadRendererPool(context.applicationContext) }
	rendererPool.onRetry = { team, id -> scope.launch { repo.retrySend(team, id) } }
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
			// A tapped notification surfaces its thread - dismiss any settings/manage overlay so the
			// thread is not masked (rendering shows settings before openTeam) and the next back press
			// is not consumed invisibly clearing it.
			showSettings = false
			settingsRoute = SettingsRoute.HUB
			showManage = false
			showAddGateway = false
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

	// System back navigates within the app (thread/settings/manage -> back) instead of exiting.
	BackHandler(enabled = openTeam != null || showSettings || showManage || showAddGateway) {
		when {
			showAddGateway -> showAddGateway = false
			showManage -> showManage = false
			openTeam != null -> openTeam = null
			showSettings && settingsRoute != SettingsRoute.HUB -> settingsRoute = SettingsRoute.HUB
			showSettings -> showSettings = false
		}
	}

	when {
		!state.provisioned -> ProvisionScreen(repo = repo, onProvision = { scope.launch { repo.provision(it) } })
		locked -> LockScreen(onUnlock = { activity?.let { a -> promptUnlock(a) { ok -> if (ok) unlocked = true } } })
		showAddGateway ->
			AddGatewayScreen(repo = repo, onBack = { showAddGateway = false }, onDone = { showAddGateway = false })
		showManage ->
			ManageScreen(repo = repo, onBack = { showManage = false }, onAddGateway = { showAddGateway = true })
		showSettings ->
			SettingsScreen(
				state = state,
				repo = repo,
				route = settingsRoute,
				onRoute = { settingsRoute = it },
				onSetDeviceName = { scope.launch { repo.setDeviceName(it) } },
				onToggleBiometric = { repo.setBiometricLock(it) },
				onManage = { showManage = true },
				onClear = {
					scope.launch { repo.clearAll() }
					showSettings = false
					settingsRoute = SettingsRoute.HUB
					openTeam = null
				},
				onCloseSettings = {
					showSettings = false
					settingsRoute = SettingsRoute.HUB
				},
			)
		openTeam != null -> {
			// Devcontainer names are the project identity; only loose peers take labels.
			val session = state.sessions(state.localGatewayId).firstOrNull { it.name == openTeam }
			val kind = session?.kind
			// Rename only when positively known loose; an unknown kind (team gone
			// from the list) stays un-renameable rather than defaulting open.
			val presence = when {
				session == null -> null
				session.status == "online" -> if (state.working(session.name)) "working..." else "live"
				session.status == "available" -> if (state.working(session.name)) "waking..." else "available"
				else -> "ended"
			}
			ThreadScreen(
				team = openTeam!!,
				label = state.titleLabel(openTeam!!, state.localGatewayId),
				presence = presence,
				tabs = state.openTabs,
				tabLabel = { state.label(it, state.localGatewayId) },
				messages = state.threads[openTeam].orEmpty(),
				error = state.error,
				rendererPool = rendererPool,
				canRename = kind == "loose",
				onGateway = { openTeam = it },
				onCloseTab = { t ->
					// Move off the closing tab before dropping it from openTabs, so the
					// retain() pass that destroys its renderer never targets the one
					// still on screen.
					if (t == openTeam) openTeam = state.openTabs.firstOrNull { it != t }
					repo.closeTab(t)
				},
				onSessions = { openTeam = null },
				onSend = { text, uris -> scope.launch { repo.send(openTeam!!, text, uris) } },
				onRename = { name -> repo.setLabel(openTeam!!, name) },
				onForget = {
					repo.forget(openTeam!!)
					openTeam = null
				},
			)
		}
		else ->
			SessionsScreen(
				state = state,
				onRefresh = { scope.launch { repo.refreshTeams() } },
				onSettings = {
					settingsRoute = SettingsRoute.HUB
					showSettings = true
				},
				onManage = { showManage = true },
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
fun ProvisionScreen(repo: ChatRepository, onProvision: (String) -> Unit) {
	val context = LocalContext.current
	var status by remember { mutableStateOf("") }
	var step by remember { mutableStateOf(1) }
	// Owner identity, minted-or-loaded on first read. Shown so the host can root the mesh at it.
	val signPub = remember { repo.ownerSignPub() }
	val boxPub = remember { repo.ownerBoxPub() }
	val sas = remember { repo.ownerSas() }

	fun tryProvision(text: String?, source: String) {
		val s = text?.trim().orEmpty()
		if (looksProvisionable(s)) {
			status = "Connecting..."
			onProvision(s)
		} else {
			status = "$source did not contain a valid setup."
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

	// QR scan: the host's QR carries the setup blob verbatim, so the scanned text is exactly
	// what tryProvision expects. Full-screen CameraX + ML Kit scanner.
	var scanning by remember { mutableStateOf(false) }
	if (scanning) {
		QrScanScreen(
			onResult = {
				scanning = false
				tryProvision(it, "QR")
			},
			onCancel = { scanning = false },
		)
		return
	}

	// On step 2, the system back returns to step 1 rather than leaving the screen.
	BackHandler(enabled = step == 2) {
		step = 1
		status = ""
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Link this phone") },
				navigationIcon = {
					if (step == 2) {
						TextButton(onClick = {
							step = 1
							status = ""
						}) { Text("Back") }
					}
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			Text(
				"Step $step of 2",
				style = MaterialTheme.typography.labelLarge,
				color = MaterialTheme.colorScheme.primary,
			)
			if (step == 1) {
				Text("Give your computer the key", style = MaterialTheme.typography.titleLarge)
				Text(
					"On your computer, run ./provision-console.sh. When it asks for the owner key, " +
						"tap Copy key and paste it in.",
					style = MaterialTheme.typography.bodyMedium,
				)
				Button(
					onClick = { copyToClipboard(context, """{"signPub":"$signPub","boxPub":"$boxPub"}""") },
					modifier = Modifier.fillMaxWidth(),
				) { Text("Copy key") }
				HorizontalDivider()
				Text(
					"Optional: the computer prints this code so you can confirm it matches.",
					style = MaterialTheme.typography.bodySmall,
				)
				Text(sas, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
				Button(onClick = { step = 2 }, modifier = Modifier.fillMaxWidth()) { Text("Next") }
			} else {
				Text("Scan what it gives back", style = MaterialTheme.typography.titleLarge)
				Text(
					"When setup finishes, your computer shows a QR. Scan it to finish.",
					style = MaterialTheme.typography.bodyMedium,
				)
				Button(onClick = { scanning = true }, modifier = Modifier.fillMaxWidth()) { Text("Scan QR") }
				Text("No camera on this phone?", style = MaterialTheme.typography.bodySmall)
				Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					OutlinedButton(
						onClick = { tryProvision(readClipboard(context), "Clipboard") },
						modifier = Modifier.weight(1f),
					) { Text("Paste text") }
					OutlinedButton(
						onClick = { fileLauncher.launch(arrayOf("*/*")) },
						modifier = Modifier.weight(1f),
					) { Text("Open file") }
				}
				if (status.isNotEmpty()) {
					val color =
						if (status.startsWith("Connecting")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
					Text(status, color = color)
				}
			}
		}
	}
}

private fun readClipboard(context: Context): String? {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
	return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
}

private fun copyToClipboard(context: Context, value: String) {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
	cm.setPrimaryClip(android.content.ClipData.newPlainText("owner key", value))
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
	onRefresh: () -> Unit,
	onSettings: () -> Unit,
	onManage: () -> Unit,
	onOpen: (String) -> Unit,
	onRename: (String, String) -> Unit,
	onForget: (String) -> Unit,
) {
	// Long-press flow: action menu -> rename dialog or forget confirm.
	var actionTeam by remember { mutableStateOf<Team?>(null) }
	var renameTeam by remember { mutableStateOf<Team?>(null) }
	var forgetTeam by remember { mutableStateOf<Team?>(null) }
	// Per-Gateway accordion collapse state (default expanded).
	val collapsedGateways = remember { mutableStateMapOf<String, Boolean>() }

	actionTeam?.let { team ->
		SessionActionsDialog(
			label = state.label(team.name, state.localGatewayId),
			canRename = team.kind != "devcontainer" && team.kind != "gateway",
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
			team = team.displayName,
			current = state.label(team.name, state.localGatewayId),
			onSave = {
				onRename(team.name, it)
				renameTeam = null
			},
			onDismiss = { renameTeam = null },
		)
	}
	forgetTeam?.let { team ->
		ConfirmDialog(
			title = "Forget ${state.label(team.name, state.localGatewayId)}?",
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
					IconButton(onClick = onRefresh) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
					TextButton(onClick = onSettings) { Text("Settings") }
				},
			)
		},
	) { pad ->
		Column(Modifier.padding(pad).fillMaxSize()) {
			val sessions = state.sessions(state.localGatewayId)
			// One status surface: when the board is empty, EmptyBoard owns the whole message, so the
			// health banner shows only ALONGSIDE a session list and can never contradict the body.
			if (sessions.isNotEmpty()) HealthHeader(state)
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
			if (sessions.isEmpty()) {
				EmptyBoard(state, onManage, onRefresh)
			} else {
				val order = sessionOrder(state)
				// Accordion grouped by owning Gateway; within each: host agent, then devcontainer
				// projects, then loose sessions. The local Gateway sorts first.
				val byGateway = sessions
					.groupBy { it.gatewayId.ifEmpty { state.localGatewayId } }
					.toList()
					.sortedBy { (id, _) -> if (id == state.localGatewayId) "" else id }
				LazyColumn(
					Modifier.fillMaxSize(),
					contentPadding = PaddingValues(12.dp),
					verticalArrangement = Arrangement.spacedBy(8.dp),
				) {
					for ((gatewayId, group) in byGateway) {
						val collapsed = collapsedGateways[gatewayId] == true
						item(key = "sw:$gatewayId") {
							GatewayHeader(
								name = gatewayId,
								online = group.any { it.status == "online" },
								collapsed = collapsed,
								onToggle = { collapsedGateways[gatewayId] = !collapsed },
							)
						}
						if (!collapsed) {
							val host = group.filter { it.kind == "gateway" }.sortedWith(order)
							val projects = group.filter { it.kind == "devcontainer" }.sortedWith(order)
							val loose = group.filter { it.kind != "gateway" && it.kind != "devcontainer" }.sortedWith(order)
							items(host + projects + loose, key = { "team:${it.name}" }) { team ->
								SessionCard(
									state = state,
									team = team,
									onClick = { onOpen(team.name) },
									onLongPress = { actionTeam = team },
								)
							}
						}
					}
				}
			}
		}
	}
}

/** The single status surface when the board has no sessions. The HealthHeader is hidden in this
 * state (SessionsScreen shows it only ALONGSIDE a session list), so this is the ONLY place a status
 * renders: exactly one mutually exclusive branch, keyed on the connection state. A terminal cause is
 * checked before the enrolling/connecting spinners, so a hard error can never sit under a "Setting
 * up..." spinner, and it names the actual cause with a way forward instead of pointing elsewhere. */
@Composable
private fun EmptyBoard(state: ChatState, onManage: () -> Unit, onRefresh: () -> Unit) {
	Column(
		Modifier.fillMaxSize().padding(32.dp),
		horizontalAlignment = Alignment.CenterHorizontally,
		verticalArrangement = Arrangement.Center,
	) {
		when {
			// No Gateway admitted yet: the primary onboarding step, with a real action.
			state.needsGateway -> {
				Text("No Gateways yet", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody("Add a Gateway to start talking to your agent sessions.")
				Spacer(Modifier.height(20.dp))
				Button(onClick = onManage) { Text("Add a Gateway") }
			}
			// A terminal failure that will not self-heal (secure storage, 401, admission rejected, or
			// an enrollment that gave up past the grace window). Name the actual cause from `error`
			// and offer a way forward - never "see the banner above", which is not on screen here.
			state.status == "error" -> {
				Text("Can't connect", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody(state.error ?: "Something went wrong reaching your Gateway.")
				Spacer(Modifier.height(20.dp))
				Button(onClick = onRefresh) { Text("Try again") }
				Spacer(Modifier.height(4.dp))
				TextButton(onClick = onManage) { Text("Manage Gateways") }
			}
			// Mid-enrollment, still self-healing: the poll loop keeps retrying and clears it on the
			// first success; past the grace window it escalates into the terminal branch above.
			state.enrollingSince != 0L -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Setting up...", style = MaterialTheme.typography.titleMedium)
				Spacer(Modifier.height(4.dp))
				BoardBody("Finishing enrollment with your Gateway.")
			}
			// Establishing the connection for the first time.
			!state.connected -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Connecting...", color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
			// Connected but the recent polls failed: online-ish, quietly reconnecting.
			state.pollFailStreak > 0 -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Reconnecting...", color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
			// Connected and healthy, just nothing here yet.
			else -> Text("No active sessions yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

/** Centered, muted body copy shared by the empty-board states. */
@Composable
private fun BoardBody(text: String) {
	Text(
		text,
		style = MaterialTheme.typography.bodyMedium,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
		textAlign = TextAlign.Center,
	)
}

@Composable
fun HealthHeader(state: ChatState) {
	val (dot, label) = when {
		// Enrolled but no Gateway admitted yet is an ONBOARDING state, not a red error: the board
		// body owns the Add-a-Gateway CTA, so the header stays a calm positive status (no duplicate).
		state.needsGateway -> Color(0xFF0969DA) to "Enrolled"
		state.health == ChatState.Health.ONLINE -> Color(0xFF2EA043) to "Bridge online"
		// Calm blue while a fresh enrollment's allowlist is still syncing to its Gateway -
		// a normal, self-healing window, not an error.
		state.health == ChatState.Health.SYNCING -> Color(0xFF0969DA) to (state.error ?: "Finishing up enrollment...")
		// Show the SPECIFIC classified cause (set by classifyConnError) rather than a
		// blanket label, so the header tells the human exactly what to fix.
		state.health == ChatState.Health.DEGRADED -> Color(0xFFD29922) to (state.error ?: "Reconnecting...")
		else -> Color(0xFFCF222E) to (state.error ?: "Offline")
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
private fun GatewayHeader(name: String, online: Boolean, collapsed: Boolean, onToggle: () -> Unit) {
	Row(
		Modifier
			.fillMaxWidth()
			.clip(MaterialTheme.shapes.small)
			.clickable(onClick = onToggle)
			.padding(horizontal = 4.dp, vertical = 8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		// The caret is the expand/collapse affordance: down when collapsed, up when open.
		Icon(
			if (collapsed) Icons.Default.ExpandMore else Icons.Default.ExpandLess,
			contentDescription = if (collapsed) "Expand" else "Collapse",
			tint = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Spacer(Modifier.width(10.dp))
		Text(name, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace)
		Spacer(Modifier.weight(1f))
		Text(
			if (online) "online" else "offline",
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
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
	val display = if (team.kind == "gateway") "Gateway" else state.label(team.name, state.localGatewayId)
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
			// Under a custom label, surface the session's short local name so the user
			// can still tell which session it maps to. label() falls back to the short
			// name, so an unlabeled session adds nothing here.
			if (display != team.displayName && team.kind != "gateway") {
				Text(
					team.displayName,
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
					"CLI agent - console chat is not supported",
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
	onGateway: (String) -> Unit,
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

	// Hold the screen awake while a thread is open (reading or replying); released
	// when this screen leaves the composition.
	val view = LocalView.current
	DisposableEffect(view) {
		view.keepScreenOn = true
		onDispose { view.keepScreenOn = false }
	}

	if (showRename) {
		RenameDialog(
			// `team` is the host-qualified id; show only the short local name (tail
			// after the "/" qualifier) as the rename context.
			team = team.substringAfter('/'),
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
				navigationIcon = {
					IconButton(onClick = onSessions) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to sessions")
					}
				},
				actions = {
					IconButton(onClick = { showMenu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More options") }
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
				PrimaryScrollableTabRow(selectedTabIndex = selected, edgePadding = 8.dp) {
					tabs.forEachIndexed { i, t ->
						Tab(selected = i == selected, onClick = { onGateway(t) }, text = { Text(tabLabel(t)) })
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
								IconButton(onClick = { attachments = attachments - uri }) {
									Icon(Icons.Default.Close, contentDescription = "Remove attachment")
								}
							}
						}
					}
				}
			}
			Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
				OutlinedTextField(
					value = draft,
					onValueChange = { draft = it },
					label = { Text("Message") },
					modifier = Modifier.weight(1f),
				)
				// Attach stacks above Send in a narrow right column, handing the text
				// field the width the inline Attach button used to occupy.
				Column(Modifier.padding(start = 8.dp), horizontalAlignment = Alignment.End) {
					IconButton(onClick = { picker.launch(arrayOf("*/*")) }) {
							Icon(Icons.Default.AttachFile, contentDescription = "Attach file")
						}
					FilledIconButton(
						enabled = draft.isNotBlank() || attachments.isNotEmpty(),
						onClick = {
							onSend(draft, attachments)
							draft = ""
							attachments = emptyList()
						},
					) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send") }
				}
			}
		}
	}
}

/** The settings hub's routes: the hub plus one focused sub-screen each. A plain enum
 * (Serializable), so App() holds the current route in rememberSaveable across rotation. */
enum class SettingsRoute { HUB, PROFILE, VOICE, NETWORKS, SECURITY, SYSTEM }

private fun settingsTitle(route: SettingsRoute): String = when (route) {
	SettingsRoute.HUB -> "Settings"
	SettingsRoute.PROFILE -> "Profile"
	SettingsRoute.VOICE -> "Voice & TTS"
	SettingsRoute.NETWORKS -> "Networks & Trust"
	SettingsRoute.SECURITY -> "Security"
	SettingsRoute.SYSTEM -> "System"
}

/** Settings hub-and-spoke: the hub lists tappable category rows; each drills into a
 * focused sub-screen. Back pops a sub-screen to the hub, and the hub closes settings
 * (the App-level BackHandler mirrors this for the system back button). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
	state: ChatState,
	repo: ChatRepository,
	route: SettingsRoute,
	onRoute: (SettingsRoute) -> Unit,
	onSetDeviceName: (String) -> Unit,
	onToggleBiometric: (Boolean) -> Unit,
	onManage: () -> Unit,
	onClear: () -> Unit,
	onCloseSettings: () -> Unit,
) {
	val onBack = { if (route == SettingsRoute.HUB) onCloseSettings() else onRoute(SettingsRoute.HUB) }
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(settingsTitle(route)) },
				navigationIcon = {
					IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			when (route) {
				SettingsRoute.HUB -> {
					SettingsRow(Icons.Default.Person, "Profile") { onRoute(SettingsRoute.PROFILE) }
					SettingsRow(Icons.Default.RecordVoiceOver, "Voice & TTS") { onRoute(SettingsRoute.VOICE) }
					SettingsRow(Icons.Default.Hub, "Networks & Trust") { onRoute(SettingsRoute.NETWORKS) }
					SettingsRow(Icons.Default.Lock, "Security") { onRoute(SettingsRoute.SECURITY) }
					SettingsRow(Icons.Default.Tune, "System") { onRoute(SettingsRoute.SYSTEM) }
				}
				SettingsRoute.PROFILE -> ProfileSettings(state, onSetDeviceName)
				SettingsRoute.VOICE -> SttsVoiceSection(repo)
				SettingsRoute.NETWORKS -> NetworksSettings(repo, onManage)
				SettingsRoute.SECURITY -> SecuritySettings(state, onToggleBiometric)
				SettingsRoute.SYSTEM -> SystemSettings(onClear)
			}
		}
	}
}

/** A tappable hub row: a leading category icon, the label, and a trailing drill-in chevron.
 * The icons are decorative (the label announces the row), so contentDescription is null. */
@Composable
private fun SettingsRow(icon: ImageVector, label: String, onClick: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(
			icon,
			contentDescription = null,
			modifier = Modifier.padding(end = 16.dp),
			tint = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Text(label, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
		Icon(Icons.Default.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
	}
}

@Composable
private fun ProfileSettings(state: ChatState, onSetDeviceName: (String) -> Unit) {
	var name by remember { mutableStateOf(state.deviceName) }
	Text("Device name", style = MaterialTheme.typography.titleMedium)
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedTextField(value = name, onValueChange = { name = it }, modifier = Modifier.weight(1f))
		Button(
			enabled = name.isNotBlank() && name != state.deviceName,
			onClick = { onSetDeviceName(name.trim()) },
			modifier = Modifier.padding(start = 8.dp),
		) { Text("Save") }
	}
}

@Composable
private fun NetworksSettings(repo: ChatRepository, onManage: () -> Unit) {
	Button(onClick = onManage, modifier = Modifier.fillMaxWidth()) { Text("Manage gateways") }
	OwnerKeysCard(repo)
	OwnerBackupCard(repo)
}

@Composable
private fun SecuritySettings(state: ChatState, onToggleBiometric: (Boolean) -> Unit) {
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text("Biometric lock", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
		Switch(checked = state.biometricLock, onCheckedChange = onToggleBiometric)
	}
	Text(
		"Require fingerprint or device PIN on app open. Falls back to unlocked if nothing is enrolled.",
		style = MaterialTheme.typography.bodySmall,
	)
}

/** System settings; the danger action (Clear & re-provision) sits at the bottom behind a
 * confirm, so a wipe is two levels deep (Settings -> System) plus an explicit confirmation. */
@Composable
private fun SystemSettings(onClear: () -> Unit) {
	var confirmClear by remember { mutableStateOf(false) }
	BatteryExemptionRow()
	HorizontalDivider()
	AppUpdateRow()
	HorizontalDivider()
	Text("Danger", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
	OutlinedButton(
		onClick = { confirmClear = true },
		colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
	) {
		Icon(Icons.Default.DeleteForever, contentDescription = null, modifier = Modifier.size(18.dp))
		Spacer(Modifier.width(4.dp))
		Text("Clear & re-provision")
	}
	Text(
		"Removes the stored credential and chat history. Voice settings are kept.",
		style = MaterialTheme.typography.bodySmall,
	)
	if (confirmClear) {
		AlertDialog(
			onDismissRequest = { confirmClear = false },
			title = { Text("Clear & re-provision?") },
			text = { Text("Removes the stored credential and chat history from this device. Voice settings are kept.") },
			confirmButton = { TextButton(onClick = { confirmClear = false; onClear() }) { Text("Clear") } },
			dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
		)
	}
}

// Cap the rendered voice menu: some providers ship hundreds of voices, and the
// field's text filters the rest into view.
private const val MAX_VOICE_MENU_ITEMS = 60

/** The Voice connection's single honest state, shown on the settings status line.
 * DIRTY = creds edited but not yet re-Tested (the voice/Play block stays hidden). */
internal enum class SttsConn { NOT_SET_UP, DIRTY, TESTING, CONNECTED, NO_VOICES, FAILED }

/** Pure fold of a probe + catalog presence into the honest connection state, so a JVM
 * test pins it: Ok+voices -> CONNECTED, Ok-but-no-catalog -> NO_VOICES (a green status
 * never sits over a dimmed picker), Unreachable -> FAILED with the reason passed through. */
internal fun foldConn(probe: SttsProbe, hasVoices: Boolean): Pair<SttsConn, String> =
	when (probe) {
		is SttsProbe.Ok -> (if (hasVoices) SttsConn.CONNECTED else SttsConn.NO_VOICES) to ""
		is SttsProbe.Unreachable -> SttsConn.FAILED to probe.reason
	}

private suspend fun resolveConn(repo: ChatRepository): Pair<SttsConn, String> =
	foldConn(repo.sttsProbe(), repo.sttsReady())

/** Voice settings for message playback: provider picker, a voice dropdown that
 * lists the selected provider's curated voices (still typeable for voices not
 * in the catalog), an audible sample preview, and a service liveness line.
 * Values persist in prefs (not the credential blob) through the repository. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SttsVoiceSection(repo: ChatRepository) {
	val providers = remember { repo.sttsProviders() }
	var providerId by remember { mutableStateOf(repo.sttsProviderId) }
	val current = providers.firstOrNull { it.id == providerId }
	var voice by remember(providerId) { mutableStateOf(repo.sttsVoiceFor(providerId)) }
	var pickerOpen by remember { mutableStateOf(false) }
	var voiceMenuOpen by remember { mutableStateOf(false) }
	var sampleError by remember { mutableStateOf<String?>(null) }
	// Failed previews surface here instead of dead-ending in the log (snapshot
	// state writes are thread-safe, so the player thread can set it directly).
	DisposableEffect(Unit) {
		repo.stts.onPlaybackError = { reason -> sampleError = reason }
		onDispose { repo.stts.onPlaybackError = null }
	}

	// CONNECTION - the single honest status. The voice + playback controls below stay
	// hidden until a Test confirms BOTH the service and a voice catalog, so a green
	// status can never sit over a dimmed picker. Creds live in settings, not the blob.
	// Plain remember, NOT rememberSaveable: the store is the durable source (re-read on
	// composition), so a config change loses nothing, and the secret never enters the
	// saved-instance-state Bundle. A half-typed key resetting on rotation is the right trade.
	var url by remember { mutableStateOf(repo.sttsUrl) }
	var key by remember { mutableStateOf(repo.sttsKey) }
	var conn by remember { mutableStateOf(if (repo.sttsConfigured()) SttsConn.TESTING else SttsConn.NOT_SET_UP) }
	var failReason by remember { mutableStateOf("") }
	// Bumped on every creds edit / Test; a probe ignores its result once the gen moves on, so
	// an edit (or a double-tap) cannot let a stale probe revive a superseded state.
	var probeGen by remember { mutableStateOf(0) }
	val scope = rememberCoroutineScope()
	// The one generation-guarded probe: go TESTING, bump the gen, probe off the main thread, and
	// apply the result only if no newer edit/Test superseded it. Used by both the entry probe and Test.
	val runProbe = {
		conn = SttsConn.TESTING
		val gen = ++probeGen
		scope.launch {
			val (c, r) = resolveConn(repo)
			if (gen == probeGen) {
				conn = c
				failReason = r
			}
		}
	}
	LaunchedEffect(Unit) { if (repo.sttsConfigured()) runProbe() }
	// The provider dialog lives below the Connected gate; if the section collapses (creds
	// edited, or a re-Test fails), drop it so it cannot reappear unbidden on reconnect.
	LaunchedEffect(conn) { if (conn != SttsConn.CONNECTED) pickerOpen = false }

	// A creds edit demotes a resolved state to DIRTY (re-arming the Connected gate so the
	// voice/Play block hides and playback cannot use stale creds), closes the provider dialog,
	// and invalidates any in-flight probe.
	val onCredsEdit = {
		if (conn != SttsConn.NOT_SET_UP && conn != SttsConn.DIRTY) conn = SttsConn.DIRTY
		pickerOpen = false
		probeGen++
	}

	Text("Voice", style = MaterialTheme.typography.titleMedium)
	OutlinedTextField(
		value = url,
		onValueChange = {
			url = it
			onCredsEdit()
		},
		label = { Text("Service URL") },
		singleLine = true,
		modifier = Modifier.fillMaxWidth(),
	)
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedTextField(
			value = key,
			onValueChange = {
				key = it
				onCredsEdit()
			},
			label = { Text("API key") },
			singleLine = true,
			visualTransformation = PasswordVisualTransformation(),
			modifier = Modifier.weight(1f),
		)
		Button(
			enabled = conn != SttsConn.TESTING,
			onClick = {
				// setSttsCreds is the validate+persist choke: it normalizes the URL (rejecting
				// userinfo / path / non-https that would send the key to the wrong host), stores the
				// clean origin, and returns it (null = invalid, nothing persisted).
				when {
					key.isBlank() -> conn = SttsConn.NOT_SET_UP
					else -> {
						val origin = repo.setSttsCreds(url, key)
						if (origin == null) {
							conn = SttsConn.FAILED
							failReason = "Use a valid https:// URL"
						} else {
							url = origin
							runProbe()
						}
					}
				}
			},
			modifier = Modifier.padding(start = 8.dp),
		) { Text("Test") }
	}
	Row(verticalAlignment = Alignment.CenterVertically) {
		val statusColor = when (conn) {
			SttsConn.CONNECTED -> Color(0xFF1A7F37)
			SttsConn.NO_VOICES -> Color(0xFF9A6700)
			SttsConn.FAILED -> MaterialTheme.colorScheme.error
			else -> MaterialTheme.colorScheme.onSurfaceVariant
		}
		val statusIcon = when (conn) {
			SttsConn.CONNECTED -> Icons.Default.Check
			SttsConn.NO_VOICES, SttsConn.FAILED -> Icons.Default.Warning
			else -> null
		}
		statusIcon?.let {
			Icon(it, contentDescription = null, tint = statusColor, modifier = Modifier.size(16.dp))
			Spacer(Modifier.width(4.dp))
		}
		Text(
			when (conn) {
				SttsConn.NOT_SET_UP -> "Enter your key to connect"
				SttsConn.DIRTY -> "Press Test to apply"
				SttsConn.TESTING -> "Testing..."
				SttsConn.CONNECTED -> "Connected"
				SttsConn.NO_VOICES -> "Connected, but no voices available"
				SttsConn.FAILED -> "Couldn't connect: $failReason"
			},
			style = MaterialTheme.typography.bodySmall,
			color = statusColor,
		)
	}

	// Voice + Playback unlock only when fully Connected.
	if (conn != SttsConn.CONNECTED) return
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedButton(onClick = { pickerOpen = true }) { Text(current?.label ?: providerId.ifEmpty { "Provider" }) }
		ExposedDropdownMenuBox(
			expanded = voiceMenuOpen,
			onExpandedChange = { voiceMenuOpen = it },
			modifier = Modifier.weight(1f).padding(start = 8.dp),
		) {
			OutlinedTextField(
				value = voice,
				onValueChange = {
					voice = it
					repo.setSttsVoiceFor(providerId, it)
					// Surface the filtered matches as the user types, not just on the
					// trailing-icon tap.
					voiceMenuOpen = true
				},
				label = { Text(current?.voiceHint?.let { "$it (blank = default)" } ?: "Voice (blank = default)") },
				trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = voiceMenuOpen) },
				singleLine = true,
				modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryEditable),
			)
			// The catalog ships the provider's full voice list (hundreds for some),
			// so the field text filters the menu by id or label. A Default entry
			// clears to the provider default. The field stays editable: ElevenLabs
			// and Uberduck ship no voices, and a custom id can always be typed.
			val query = voice.trim()
			val matches = current?.voices.orEmpty().filter {
				query.isEmpty() || it.id.contains(query, ignoreCase = true) ||
					(it.label?.contains(query, ignoreCase = true) == true)
			}
			val shown = matches.take(MAX_VOICE_MENU_ITEMS)
			ExposedDropdownMenu(expanded = voiceMenuOpen, onDismissRequest = { voiceMenuOpen = false }) {
				DropdownMenuItem(
					text = { Text("Default voice") },
					onClick = {
						voice = ""
						repo.setSttsVoiceFor(providerId, "")
						voiceMenuOpen = false
					},
				)
				for (v in shown) {
					DropdownMenuItem(
						text = {
							Column {
								Text(v.label ?: v.id)
								if (v.label != null && v.label != v.id) {
									Text(
										v.id,
										style = MaterialTheme.typography.bodySmall,
										color = MaterialTheme.colorScheme.onSurfaceVariant,
									)
								}
							}
						},
						onClick = {
							voice = v.id
							repo.setSttsVoiceFor(providerId, v.id)
							voiceMenuOpen = false
						},
					)
				}
				if (matches.size > shown.size) {
					DropdownMenuItem(
						enabled = false,
						text = {
							Text(
								"${matches.size - shown.size} more, type to narrow",
								style = MaterialTheme.typography.bodySmall,
							)
						},
						onClick = {},
					)
				}
			}
		}
	}
	current?.note?.let {
		Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}
	Button(
		enabled = current != null,
		onClick = {
			sampleError = null
			repo.playSttsSample()
		},
	) {
		Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
		Spacer(Modifier.width(4.dp))
		Text("Play a sample")
	}
	sampleError?.let {
		Text("Playback failed: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}

	var autoTts by remember { mutableStateOf(repo.sttsAutoGen) }
	Row(verticalAlignment = Alignment.CenterVertically) {
		Column(Modifier.weight(1f)) {
			Text("Auto-generate voice", style = MaterialTheme.typography.titleSmall)
			Text(
				"Pre-synthesize incoming messages for threads you have open, so Play is instant. Adds about 10s to the notification.",
				style = MaterialTheme.typography.bodySmall,
			)
		}
		Switch(
			checked = autoTts,
			onCheckedChange = {
				autoTts = it
				repo.sttsAutoGen = it
			},
		)
	}

	var autoPlay by remember { mutableStateOf(repo.sttsAutoPlaySummary) }
	Row(verticalAlignment = Alignment.CenterVertically) {
		Column(Modifier.weight(1f)) {
			Text("Auto-play summary", style = MaterialTheme.typography.titleSmall)
			Text(
				"Speak the summary aloud the moment it is ready, hands-free. Requires auto-generate voice.",
				style = MaterialTheme.typography.bodySmall,
			)
		}
		Switch(
			checked = autoPlay,
			enabled = autoTts,
			onCheckedChange = {
				autoPlay = it
				repo.sttsAutoPlaySummary = it
			},
		)
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
