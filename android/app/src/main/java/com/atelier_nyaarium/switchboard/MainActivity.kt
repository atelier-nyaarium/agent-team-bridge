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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.composeSessionName
import com.atelier_nyaarium.switchboard.proto.isComposite
import com.atelier_nyaarium.switchboard.proto.parseSessionName
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Process-lifetime repository so chat state survives Activity recreation. */
object Repo {
	@Volatile private var instance: ChatRepository? = null

	fun get(context: Context): ChatRepository =
		instance ?: synchronized(this) {
			val app = context.applicationContext
			instance ?: ChatRepository(
				AppStateStore(app),
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
	// The Gateways kebab "Manage sharing" routes here, scoped to that gateway's sessions.
	var sharingGateway by remember { mutableStateOf<String?>(null) }
	var showAddGateway by remember { mutableStateOf(false) }
	// The account "Your devices" list, and the held-device "Add a device" approval window it opens.
	var showYourDevices by remember { mutableStateOf(false) }
	var showApproval by remember { mutableStateOf(false) }
	// The board's "Running Gateway Setup" opens the host-setup manual.
	var showHostHelp by remember { mutableStateOf(false) }
	// Cross-Domain trust overlays: the Users surface (the hub for people + networks) and the
	// transient link wizard (leaving it cancels the pairing windows).
	var showUsers by remember { mutableStateOf(false) }
	var showLinkWizard by remember { mutableStateOf(false) }
	// Host-a-friend overlays: the "Networks you host" list, and the open hosted tenant's detail (its
	// domainId, or null). Kept apart from the peer overlays so hosting never reads as linking.
	var showHostNetworks by remember { mutableStateOf(false) }
	var hostTenant by remember { mutableStateOf<String?>(null) }
	// The in-person enroll compare overlays (transient, like the link wizard). The admin leg is
	// launched from a tenant's detail with the QR blob + label; the enrollee leg is the freshly-rooted
	// device's own context. Either non-null shows the ceremony; leaving cancels the broker window.
	var adminCeremonyCtx by remember { mutableStateOf<EnrollCeremonyContext?>(null) }
	var adminCeremonyBlob by remember { mutableStateOf("") }
	var adminCeremonyLabel by remember { mutableStateOf("") }
	var enrolleeCeremonyCtx by remember { mutableStateOf<EnrollCeremonyContext?>(null) }
	// One-shot so the enrollee compare auto-pops once after first-root, never re-popping after a
	// manual dismiss (the board keeps a "Verify with the admin" entry for that).
	var enrolleeCeremonyOffered by remember { mutableStateOf(false) }
	var unlocked by remember { mutableStateOf(false) }

	// WebView pool lives at App scope (never leaves composition) so each thread's
	// renderer survives Sessions round-trips and tab switches. Pruned to open tabs;
	// destroyed with the Activity.
	val rendererPool = remember { ThreadRendererPool(context.applicationContext) }
	rendererPool.onRetry = { team, id -> scope.launch { repo.retrySend(team, id) } }
	// Attribute a message's sender by its human label (a notice's `from` is a canonical address).
	// Reads the live state at render time so a rename reflects without rebuilding the pool.
	rendererPool.resolveFrom = { addr -> repo.state.value.label(addr, repo.state.value.localGatewayId) }
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
	// In-thread Play buttons render only when STTS is provisioned; taps speak the full tier, and the
	// player's now-playing pushes glyph state back. Re-evaluated per recomposition so provisioning
	// in-session lights the buttons for renderers built afterward.
	rendererPool.playEnabled = repo.sttsReady()
	rendererPool.onPlayTap = { team, at ->
		// Toggle by message: a tap stops whatever tier is playing for this message (autoplay may have
		// chosen Title/Summary), else plays it FULL. Avoids synthesizing FULL on top of an autoplay.
		if (repo.isMessagePlaying(team, at)) repo.stopPlayback() else repo.playMessage(team, at, SttsPlayer.Tier.FULL)
	}
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
	// Auto-pop the in-person enroll compare once the device first-roots an enroll invite (the admin is
	// right there, mid-scan). One-shot: a dismiss does not re-pop it; the empty board keeps a manual
	// "Verify with the admin" entry, and a completed compare latches it off.
	LaunchedEffect(state.provisioned, state.firstRooted) {
		if (state.provisioned && !enrolleeCeremonyOffered) {
			repo.pendingEnrolleeCeremony()?.let {
				enrolleeCeremonyCtx = it
				enrolleeCeremonyOffered = true
			}
		}
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
			val opened = repo.openThread(team)
			// A tapped notification surfaces its thread - dismiss any settings/manage overlay so the
			// thread is not masked (rendering shows settings before openTeam) and the next back press
			// is not consumed invisibly clearing it.
			showSettings = false
			settingsRoute = SettingsRoute.HUB
			showManage = false
			sharingGateway = null
			showAddGateway = false
			showYourDevices = false
			showApproval = false
			showHostHelp = false
			showUsers = false
			showLinkWizard = false
			showHostNetworks = false
			hostTenant = null
			adminCeremonyCtx = null
			enrolleeCeremonyCtx = null
			openTeam = opened
			openTeamRequest.value = null
		}
	}
	// Reading a thread clears its bar notification no matter how it was opened
	// (session card, notification tap, or tab) - the bar mirrors unread state.
	LaunchedEffect(openTeam) {
		openTeam?.let { SwitchboardService.cancelTeamNotification(context, it) }
	}

	// Working-chip poll: the open chat is peeked continuously; other listed sessions get one cheap
	// peek per list change (no rearm). Only local composite sessions have a daemon-drivable pane.
	val boardSessions = state.sessions(state.localGatewayId)
	LaunchedEffect(openTeam) {
		val t = openTeam ?: return@LaunchedEffect
		if (!isComposite(localFieldOf(t))) return@LaunchedEffect
		while (true) {
			repo.pokeWorking(t)
			delay(repo.terminalRefreshMs)
		}
	}
	LaunchedEffect(boardSessions.map { it.name }.sorted(), openTeam) {
		if (openTeam != null) return@LaunchedEffect
		for (s in boardSessions) {
			val local = s.gatewayId.isEmpty() || s.gatewayId == state.localGatewayId
			if (local && isComposite(s.shortName)) repo.pokeWorking(s.name)
		}
	}

	val locked = state.provisioned && state.biometricLock && !unlocked
	LaunchedEffect(locked) {
		if (locked && activity != null) promptUnlock(activity) { ok -> if (ok) unlocked = true }
	}

	// System back navigates within the app (thread/settings/manage -> back) instead of exiting.
	BackHandler(
		enabled = openTeam != null || showSettings || showManage || showAddGateway || showHostHelp ||
			sharingGateway != null || showUsers || showLinkWizard || showHostNetworks ||
			hostTenant != null || adminCeremonyCtx != null || enrolleeCeremonyCtx != null ||
			showYourDevices || showApproval,
	) {
		when {
			adminCeremonyCtx != null -> adminCeremonyCtx = null
			enrolleeCeremonyCtx != null -> enrolleeCeremonyCtx = null
			showLinkWizard -> showLinkWizard = false
			hostTenant != null -> hostTenant = null
			showHostNetworks -> showHostNetworks = false
			showUsers -> showUsers = false
			showApproval -> showApproval = false
			showYourDevices -> showYourDevices = false
			showAddGateway -> showAddGateway = false
			showHostHelp -> showHostHelp = false
			sharingGateway != null -> sharingGateway = null
			showManage -> showManage = false
			openTeam != null -> openTeam = null
			showSettings && settingsRoute != SettingsRoute.HUB -> settingsRoute = SettingsRoute.HUB
			showSettings -> showSettings = false
		}
	}

	when {
		// Lock wins over everything (a provisioned + locked session must show the lock, never a
		// leftover overlay underneath it). An unprovisioned session is never locked.
		locked -> LockScreen(onUnlock = { activity?.let { a -> promptUnlock(a) { ok -> if (ok) unlocked = true } } })
		// The in-person enroll compare overlays both the tenant detail (admin) and the board (enrollee),
		// so they sit above those branches. Admin carries the QR blob; enrollee latches done on success.
		adminCeremonyCtx != null ->
			EnrollCeremonyScreen(
				repo = repo,
				ctx = adminCeremonyCtx!!,
				inviteBlob = adminCeremonyBlob,
				peerLabel = adminCeremonyLabel.ifEmpty { "the new user" },
				onDone = { adminCeremonyCtx = null },
				onCancel = { adminCeremonyCtx = null },
			)
		enrolleeCeremonyCtx != null ->
			EnrollCeremonyScreen(
				repo = repo,
				ctx = enrolleeCeremonyCtx!!,
				inviteBlob = null,
				peerLabel = "the admin",
				onDone = {
					repo.markEnrolleeCeremonyDone()
					enrolleeCeremonyCtx = null
				},
				onCancel = { enrolleeCeremonyCtx = null },
			)
		showLinkWizard ->
			LinkWizard(
				repo = repo,
				onDone = { showLinkWizard = false },
				onCancel = { showLinkWizard = false },
			)
		hostTenant != null ->
			HostedTenantDetailScreen(
				repo = repo,
				domainId = hostTenant!!,
				onBack = { hostTenant = null },
				onRemoved = { hostTenant = null },
				onLink = { showLinkWizard = true },
				onVerify = { blob, label ->
					repo.adminEnrollContext(hostTenant!!)?.let {
						adminCeremonyCtx = it
						adminCeremonyBlob = blob
						adminCeremonyLabel = label
					}
				},
			)
		showHostNetworks ->
			HostNetworksScreen(
				repo = repo,
				onBack = { showHostNetworks = false },
				onTenant = { hostTenant = it },
			)
		showUsers ->
			UsersScreen(
				repo = repo,
				onBack = { showUsers = false },
				onEnrollUser = {
					showUsers = false
					showHostNetworks = true
				},
				onLink = { showLinkWizard = true },
				onHostNetworks = { showHostNetworks = true },
				onAddGateway = { showAddGateway = true },
			)
		showApproval ->
			ApprovalWindowScreen(repo = repo, onBack = { showApproval = false })
		showYourDevices ->
			YourDevicesScreen(
				repo = repo,
				onBack = { showYourDevices = false },
				onAddDevice = { showApproval = true },
			)
		showAddGateway ->
			AddGatewayScreen(repo = repo, onBack = { showAddGateway = false }, onDone = { showAddGateway = false })
		showHostHelp ->
			HostSetupHelpScreen(onBack = { showHostHelp = false })
		sharingGateway != null ->
			SharingScreen(repo = repo, gatewayId = sharingGateway, onBack = { sharingGateway = null })
		showManage ->
			GatewaysScreen(
				repo = repo,
				teams = state.teams,
				onBack = { showManage = false },
				onAddGateway = { showAddGateway = true },
				onManageSharing = { gid -> sharingGateway = gid },
			)
		// Settings is reachable from ANY state, so this branch is evaluated BEFORE the unprovisioned
		// ProvisionScreen below (the setup screen's gear opens it). It sits below the overlay branches
		// above, which are entered from Settings without clearing showSettings, so they must still win.
		// SettingsScreen gates its provisioned-only rows, so the unprovisioned hub shows only System.
		showSettings ->
			SettingsScreen(
				state = state,
				repo = repo,
				route = settingsRoute,
				onRoute = { settingsRoute = it },
				onSetDeviceName = { scope.launch { repo.setDeviceName(it) } },
				onToggleBiometric = { repo.setBiometricLock(it) },
				onManage = { showManage = true },
				onYourDevices = {
					showSettings = false
					settingsRoute = SettingsRoute.HUB
					showYourDevices = true
				},
				onFederation = {
					// Users is the federation surface; the federation actions live in its top-bar menu.
					showSettings = false
					settingsRoute = SettingsRoute.HUB
					showUsers = true
				},
				onClear = {
					// The Domain-delete transaction (repo.deleteDomain) owns the local wipe; this only
					// navigates home once it completes.
					showSettings = false
					settingsRoute = SettingsRoute.HUB
					openTeam = null
				},
				onCloseSettings = {
					showSettings = false
					settingsRoute = SettingsRoute.HUB
				},
			)
		!state.provisioned ->
			ProvisionScreen(
				repo = repo,
				state = state,
				onProvision = { scope.launch { repo.provision(it) } },
				onSettings = { showSettings = true },
			)
		openTeam != null -> {
			// Devcontainer names are the project identity; only loose peers take labels.
			val session = state.sessions(state.localGatewayId).firstOrNull { it.name == openTeam }
			val kind = session?.kind
			// Rename only when positively known loose; an unknown kind (team gone
			// from the list) stays un-renameable rather than defaulting open.
			val presence = when {
				session == null -> null
				session.status == "online" -> when {
					state.needsLogin(session.name) -> "check terminal"
					state.working(session.name) -> "working..."
					else -> "live"
				}
				session.status == "available" -> if (state.working(session.name)) "waking..." else "available"
				else -> statusWord(session.status)
			}
			ThreadScreen(
				team = openTeam!!,
				label = tabLabelFor(state, openTeam!!),
				presence = presence,
				tabs = state.openTabs,
				tabLabel = { tabLabelFor(state, it) },
				messages = state.threads[openTeam].orEmpty(),
				// During a wake the "Waking..." placeholder already explains the wait, so suppress the
				// auto-retry connection banner (the transient "... - retrying" causes). A real error
				// (terminal causes never end in "retrying") still surfaces.
				error = state.error?.takeUnless { presence == "waking..." && it.endsWith("retrying") },
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
				initialDraft = repo.draft(openTeam!!),
				onDraftChange = { repo.setDraft(openTeam!!, it) },
				onRename = { name -> scope.launch { repo.rename(openTeam!!, name) } },
				onForget = {
					repo.forget(openTeam!!)
					openTeam = null
				},
				// A LOCAL composite session has a daemon-drivable pane; remote-Gateway is gated off in v1,
				// and the host machine's terminal is reached through the dedicated "host" target.
				terminalEligible = isComposite(localFieldOf(openTeam!!)) &&
					(session?.gatewayId.isNullOrEmpty() || session?.gatewayId == state.localGatewayId),
				// The terminal view opens by default (docker-logs then tmux) for a session that is not
				// yet live, so a booting or stuck session is visible without a manual toggle; the Wake
				// button reattaches an asleep one.
				sessionStatus = session?.status,
				// A "verifying" session is coming up (a wake in flight, through the MCP handshake), so the
				// terminal seeds "Waking..." rather than "asleep"; a plain asleep session reads "asleep".
				wakePending = session?.status == "verifying",
				onWake = { repo.wakeSession(openTeam!!) },
				terminalRefreshMs = repo.terminalRefreshMs,
				onTerminalPeek = { hash -> repo.peekTerminal(openTeam!!, hash) },
				onTerminalSend = { text, key, submit -> repo.tmuxSend(openTeam!!, text, key, submit) },
			)
		}
		else -> {
			val snackbarHostState = remember { SnackbarHostState() }
			// One-shot: a create_session failure or abandonment surfaces here instead of the sticky
			// connection-health state.error, so it never bleeds into an unrelated later health render.
			LaunchedEffect(state.transientMessage) {
				state.transientMessage?.let {
					repo.consumeTransientMessage()
					snackbarHostState.showSnackbar(it)
				}
			}
			SessionsScreen(
				state = state,
				snackbarHostState = snackbarHostState,
				onRefresh = { scope.launch { repo.refreshTeams() } },
				onSettings = {
					settingsRoute = SettingsRoute.HUB
					showSettings = true
				},
				onManage = { showManage = true },
				onAddGateway = { showAddGateway = true },
				onHostHelp = { showHostHelp = true },
				onOpen = { team ->
					openTeam = repo.openThread(team)
					SwitchboardService.cancelTeamNotification(context, team)
				},
				onRename = { team, name -> scope.launch { repo.rename(team, name) } },
				onForget = { team -> repo.forget(team) },
				// Fire the create and stay on the board: the gateway adopts the session's record
				// synchronously, so its own tile appears via the teams() refresh (spinner while it boots).
				// Tapping the tile opens its terminal view. A failure surfaces as a Snackbar.
				onSpawn = { project, label -> scope.launch { repo.spawnSession(project, label) } },
				// Launch the enrollee compare from the empty board when one is still owed (the device
				// rooted an enroll invite but has not completed the in-person trust step).
				onVerifyEnroll = (if (state.provisioned) repo.pendingEnrolleeCeremony() else null)
					?.let { c -> { enrolleeCeremonyCtx = c } },
			)
		}
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
			Button(onClick = hapticClick(onUnlock)) { Text("Unlock") }
		}
	}
}

/** The neutral fresh-open: one "Scan your setup code" screen (Scan QR / Paste / Open file). The
 * SAME import handles BOTH an admin provisioning blob AND a friend invite; the app distinguishes
 * them on connect (a pending tenant first-roots the silently-generated owner key, an already-rooted
 * Domain just provisions the console), so the human never picks a path and no path labels appear.
 * The host-setup instructions live behind a tucked "Setting up a host?" link a friend never needs. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProvisionScreen(repo: ChatRepository, state: ChatState, onProvision: (String) -> Unit, onSettings: () -> Unit) {
	val context = LocalContext.current
	var status by remember { mutableStateOf("") }
	var scanning by remember { mutableStateOf(false) }
	var showHostHelp by remember { mutableStateOf(false) }
	// The "Add a device" self-enroll path: a fresh install joining an existing owner's Domain by
	// scanning an authorize-console QR shown on a held device.
	var addDevice by remember { mutableStateOf(false) }
	// A blob that passes looksProvisionable() but fails the strict kotlinx parse inside provision()
	// leaves us on this screen with provisioned=false and the real cause on state.error. Track the
	// attempt so we can swap the local "Connecting..." for that cause instead of stalling on it.
	var provisionAttempted by remember { mutableStateOf(false) }
	// The silent owner key is minted-or-loaded on first read, so it exists before any first-root;
	// the human never sees or pastes it (the host-setup manual reads the public keys for the
	// admin path). Touch it here so it is generated up front. Non-throwing: a corrupt stored key
	// must not crash app start - the connect path surfaces it as a terminal cause.
	LaunchedEffect(Unit) { repo.ownerKeysForDisplay() }

	fun tryProvision(text: String?, source: String) {
		val s = text?.trim().orEmpty()
		if (looksProvisionable(s)) {
			status = "Connecting..."
			provisionAttempted = true
			onProvision(s)
		} else {
			provisionAttempted = false
			status = "No setup code in that $source. Check it, or ask whoever sent it."
		}
	}

	// SAF file picker. arrayOf("*/*") so a .json with any reported MIME type is selectable.
	val fileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
		if (uri == null) return@rememberLauncherForActivityResult
		val text = runCatching {
			context.contentResolver.openInputStream(uri)?.use { it.readBytes().decodeToString() }
		}.getOrNull()
		tryProvision(text, "file")
	}

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

	if (showHostHelp) {
		HostSetupHelpScreen(onBack = { showHostHelp = false })
		return
	}

	if (addDevice) {
		NewDeviceScreen(repo = repo, onBack = { addDevice = false })
		return
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Set up") },
				actions = {
					IconButton(onClick = hapticClick(onSettings)) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			Text("Scan your setup code", style = MaterialTheme.typography.titleLarge)
			Text(
				"Scan or paste the one-time code you were sent.",
				style = MaterialTheme.typography.bodyMedium,
			)
			Button(onClick = hapticClick { scanning = true }, modifier = Modifier.fillMaxWidth()) { Text("Scan QR") }
			Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				OutlinedButton(
					onClick = hapticClick { tryProvision(readClipboard(context), "clipboard") },
					modifier = Modifier.weight(1f),
				) { Text("Paste") }
				OutlinedButton(
					onClick = hapticClick { fileLauncher.launch(arrayOf("*/*")) },
					modifier = Modifier.weight(1f),
				) { Text("Open file") }
			}
			// A strict-parse rejection from provision() lands on state.error while we are still on this
			// screen (provisioned stays false); prefer it over the stale local "Connecting..." so a
			// type-malformed blob reads like the missing-field case instead of an endless spinner.
			val parseError = state.error?.takeIf { provisionAttempted && it.isNotBlank() }
			val shown = parseError ?: status
			if (shown.isNotEmpty()) {
				val color =
					if (parseError == null && status.startsWith("Connecting")) {
						MaterialTheme.colorScheme.primary
					} else {
						MaterialTheme.colorScheme.error
					}
				Text(shown, color = color)
			}
			Spacer(Modifier.height(8.dp))
			HorizontalDivider()
			// The "Add a device" self-enroll: a second phone for an EXISTING owner scans a code shown
			// on a device they already use, instead of pasting a setup blob.
			TextButton(onClick = hapticClick { addDevice = true }) { Text("Adding another device to your account?") }
			// Tucked, text-only host-setup manual behind a small link. The admin finds it here;
			// a friend with an invite never opens it.
			TextButton(onClick = hapticClick { showHostHelp = true }) { Text("Setting up your own Domain?") }
		}
	}
}

/** NEW device side of "Add a device": a fresh, unprovisioned app joining an EXISTING owner's Domain.
 * It scans the held device's authorize-console QR, generates its own console identity, joins the
 * public rendezvous, and polls for the held device's biometric-gated approval. On approval it unseals
 * the console transport (verifying the owner signPub pinned from the QR) and provisions; the App's
 * provisioned branch then takes over. No owner key and no SA token ever cross the QR. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewDeviceScreen(repo: ChatRepository, onBack: () -> Unit) {
	val scope = rememberCoroutineScope()
	var scanning by remember { mutableStateOf(false) }
	var scan by remember { mutableStateOf<ScannedDeviceApproval?>(null) }
	var status by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	// True once this device has joined and is polling for the held device's approval.
	var waiting by remember { mutableStateOf(false) }

	// Poll the public ingress for the sealed reply; on arrival it installs + flips provisioned, and the
	// App leaves this screen. A terminal failure (expired window) stops the loop and surfaces the cause.
	LaunchedEffect(waiting) {
		val s = scan
		if (!waiting || s == null) return@LaunchedEffect
		while (waiting) {
			repo.newDeviceFetch(s)
				.onSuccess { installed -> if (installed) return@LaunchedEffect }
				.onFailure {
					status = it.message ?: "The approval expired - ask your other device to add it again."
					waiting = false
					return@LaunchedEffect
				}
			delay(2000)
		}
	}

	if (scanning) {
		QrScanScreen(
			onResult = { scanned ->
				scanning = false
				scope.launch {
					val parsed = repo.parseAuthorizeConsole(scanned)
					if (parsed == null) status = "That isn't an add-device code." else scan = parsed.also { status = "" }
				}
			},
			onCancel = { scanning = false },
		)
		return
	}

	Scaffold(topBar = { TopAppBar(title = { Text("Add this device") }) }) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			val s = scan
			when {
				s == null -> {
					Text("Scan the add-device code shown on a device you already use.", style = MaterialTheme.typography.bodyMedium)
					if (status.isNotEmpty()) Text(status, color = MaterialTheme.colorScheme.error)
					Button(onClick = hapticClick { scanning = true }, modifier = Modifier.fillMaxWidth()) { Text("Scan QR") }
					OutlinedButton(onClick = hapticClick(onBack), modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
				}
				waiting -> {
					Text("Waiting for approval", style = MaterialTheme.typography.titleMedium)
					Text("Approve this device on your other device. Its fingerprint:", style = MaterialTheme.typography.bodyMedium)
					Text(s.sas, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleLarge)
					if (status.isNotEmpty()) Text(status)
					OutlinedButton(
						onClick = hapticClick {
							waiting = false
							onBack()
						},
						modifier = Modifier.fillMaxWidth(),
					) { Text("Cancel") }
				}
				else -> {
					Text("Add this device?", style = MaterialTheme.typography.titleMedium)
					Text("This joins the Domain with fingerprint:", style = MaterialTheme.typography.bodyMedium)
					Text(s.sas, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleLarge)
					if (status.isNotEmpty()) Text(status)
					Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
						OutlinedButton(onClick = hapticClick(onBack), enabled = !busy) { Text("Cancel") }
						Button(
							enabled = !busy,
							onClick = hapticClick {
								scope.launch {
									busy = true
									status = "Joining..."
									repo.newDeviceJoin(s)
										.onSuccess {
											waiting = true
											status = ""
										}
										.onFailure { status = it.message ?: "Couldn't reach your other device." }
									busy = false
								}
							},
						) { Text("Add this device") }
					}
				}
			}
		}
	}
}

/** The tucked, text-only "Setting up a host" manual: the admin path (run setup.sh on
 * a computer, paste back the setup blob it emits). No QR, no key prompt - the owner key is generated
 * silently and the script reads the PUBLIC keys. Reached from the fresh-open screen AND from the
 * empty board after a friend first-roots but has no host/gateway yet (the bring-up-a-host pointer). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostSetupHelpScreen(onBack: () -> Unit) {
	BackHandler { onBack() }
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Running Gateway Setup") },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text("On your own computer", style = MaterialTheme.typography.titleMedium)
			Text(
				"Only for your own computer. Invited by a friend? Skip this - just scan the code they sent.",
				style = MaterialTheme.typography.bodyMedium,
			)
			HorizontalDivider()
			Text(
				"1. On the computer that will run your agents, clone switchboard and run " +
					"./setup.sh.\n\n" +
					"2. It asks for your name and sets everything up. No keys to paste - this app " +
					"holds your owner key.\n\n" +
					"3. It prints a setup code. Go back and scan or paste it.\n\n" +
					"4. Once connected, add a Gateway in Settings to bring your agents online.",
				style = MaterialTheme.typography.bodyMedium,
			)
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

/** The session-board grouping key: the full (Domain, Gateway) pair. A gateway id is
 * unique only within a Domain, so two linked friend Domains running an identically-named
 * gateway must group separately rather than merge. */
private data class GatewayGroupKey(val domainId: String, val gatewayId: String)

/** Live first, then most recent activity, then label, within each section. */
private fun sessionOrder(state: ChatState): Comparator<Team> =
	compareByDescending<Team> { it.isLive }
		.thenByDescending { state.lastActivity(it.name) ?: 0L }
		.thenBy { state.label(it.name, state.localGatewayId) }

/** Tab/title label for an open thread: the session's label when it is unique among the open tabs,
 * else the label qualified with the shortest suffix of the address path (the session segment, then
 * `spawn.session`, then `gateway.spawn.session`, ...) that disambiguates it, e.g. "Scratch
 * (api.claude)". Label uniqueness is only enforced per-spawn, so two open tabs sharing a label is an
 * expected collision, not a corner case - the qualifier keeps the label visible rather than falling
 * through to a bare, unlabeled address. A session with no label at all still falls through to the
 * bare address suffix, since there is no label to qualify. */
internal fun tabLabelFor(state: ChatState, team: String): String {
	val label = state.labelOrNull(team)
	val otherTabs = state.openTabs.filter { it != team }
	if (label != null && otherTabs.none { state.labelOrNull(it) == label }) return label
	val mine = team.split(Protocol.ADDRESS_SEP)
	val otherSegments = otherTabs.map { it.split(Protocol.ADDRESS_SEP) }
	// A label is free-form text - a user can type literal parentheses - so a qualified candidate
	// below must also be checked against every other open tab's own raw label, not just against
	// other tabs' address segments; otherwise a coincidentally (or deliberately) matching label
	// elsewhere could display identically to this tab's own disambiguated text.
	val otherLabels = otherTabs.mapNotNull { state.labelOrNull(it) }.toSet()
	fun candidateAt(n: Int): String? {
		val suffix = mine.takeLast(n)
		if (otherSegments.any { it.takeLast(n) == suffix }) return null
		val qualifier = suffix.joinToString(Protocol.ADDRESS_SEP)
		val candidate = if (label != null) "$label ($qualifier)" else qualifier
		return candidate.takeIf { it !in otherLabels }
	}
	// A present label prefers at least spawn.session (n=2): a bare session id alone - especially now
	// that ids are random hex, not a readable slug - tells a human nothing about which session,
	// defeating the point of qualifying at all. But a literal label elsewhere can coincidentally (or
	// deliberately) block every tier from spawn.session up through the full address at once - in that
	// exhausted case, retry the bare session id (n=1) as a last resort before giving up and showing
	// the tab fully unlabeled; a labeled-but-terser tab beats an unlabeled raw address every time. The
	// label-less fallback is unchanged (there is no label for an opaque id to ride alongside anyway).
	val tiers = if (label != null) (2..mine.size).toList() + 1 else (1..mine.size).toList()
	for (n in tiers) candidateAt(n)?.let { return it }
	return team
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
	state: ChatState,
	onRefresh: () -> Unit,
	onSettings: () -> Unit,
	onManage: () -> Unit,
	onAddGateway: () -> Unit,
	onHostHelp: () -> Unit,
	onOpen: (String) -> Unit,
	onRename: (String, String) -> Unit,
	onForget: (String) -> Unit,
	onSpawn: (String, String) -> Unit,
	onVerifyEnroll: (() -> Unit)? = null,
	snackbarHostState: SnackbarHostState = remember { SnackbarHostState() },
) {
	// Long-press flow: action menu -> rename dialog or forget confirm.
	var actionTeam by remember { mutableStateOf<Team?>(null) }
	// Tapping a spawn-point header opens the session-name dialog for that project.
	var spawnProject by remember { mutableStateOf<String?>(null) }
	var renameTeam by remember { mutableStateOf<Team?>(null) }
	var forgetTeam by remember { mutableStateOf<Team?>(null) }
	// Per-Gateway accordion collapse state (default expanded).
	val collapsedGateways = remember { mutableStateMapOf<String, Boolean>() }

	actionTeam?.let { team ->
		SessionActionsDialog(
			label = state.label(team.name, state.localGatewayId),
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
			team = team.shortName,
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
	spawnProject?.let { project ->
		SpawnDialog(
			project = project,
			onSpawn = { session ->
				onSpawn(project, session)
				spawnProject = null
			},
			onDismiss = { spawnProject = null },
		)
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Agent Sessions") },
				actions = {
					IconButton(onClick = hapticClick(onRefresh)) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
					TextButton(onClick = hapticClick(onSettings)) { Text("Settings") }
				},
			)
		},
		snackbarHost = { SnackbarHost(snackbarHostState) },
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
						"Some messages were dropped. Pull history from your Gateway to recover.",
						Modifier.padding(12.dp),
						color = MaterialTheme.colorScheme.onErrorContainer,
						style = MaterialTheme.typography.bodySmall,
					)
				}
			}
			if (sessions.isEmpty()) {
				// Offer the still-owed in-person compare only on the awaiting-host board (a freshly-rooted
				// enrollee who has not finished the trust step); EmptyBoard gates the button on that state.
				EmptyBoard(state, onManage, onAddGateway, onHostHelp, onRefresh, onVerifyEnroll = onVerifyEnroll)
			} else {
				val order = sessionOrder(state)
				// My own Domain id, learned from a local session (one owned by the connected
				// Gateway): the local listing stamps it, so I can tell a peer Domain apart
				// without threading a separate localDomainId through state. Empty until known.
				val adminDomainId = sessions.firstOrNull { it.gatewayId == state.localGatewayId }?.domainId.orEmpty()
				// Grouped by the owning (Domain, Gateway) pair. Within each group: devcontainer projects,
				// then loose sessions. The local Gateway sorts first; peer Domains follow, ordered by Domain.
				val byGateway = sessions
					.groupBy { GatewayGroupKey(it.domainId.orEmpty().ifEmpty { adminDomainId }, it.gatewayId.ifEmpty { state.localGatewayId }) }
					.toList()
					.sortedBy { (key, _) ->
						if (key.domainId == adminDomainId && key.gatewayId == state.localGatewayId) "" else "${key.domainId}/${key.gatewayId}"
					}
				LazyColumn(
					Modifier.fillMaxSize(),
					contentPadding = PaddingValues(12.dp),
					verticalArrangement = Arrangement.spacedBy(8.dp),
				) {
					for ((key, group) in byGateway) {
						val composite = "${key.domainId}/${key.gatewayId}"
						val collapsed = collapsedGateways[composite] == true
						// A peer Domain (a linked friend's) is labeled domain/gateway so a colliding
						// gateway id reads distinctly; my own Domain shows the bare gateway id.
						val isPeer = key.domainId.isNotEmpty() && adminDomainId.isNotEmpty() && key.domainId != adminDomainId
						val headerName = if (isPeer) composite else key.gatewayId
						item(key = "sw:$composite") {
							GatewayHeader(
								name = headerName,
								online = group.any { it.isLive },
								collapsed = collapsed,
								onToggle = { collapsedGateways[composite] = !collapsed },
							)
						}
						if (!collapsed) {
							// Clean break: a devcontainer entry is a non-chat SPAWN-POINT (its bare project);
							// each project.session is a loose chat that nests under its project's header. The
							// remaining non-composite loose peers (host-loose, etc.) stay flat.
							fun localName(t: Team) = t.shortName
							val spawnPoints = group.filter { it.kind == "devcontainer" }.sortedWith(order)
							val composites = group.filter { it.kind != "devcontainer" && isComposite(localName(it)) }
							val flatLoose =
								group.filter { it.kind != "devcontainer" && !isComposite(localName(it)) }.sortedWith(order)
							val byProject = composites.groupBy { parseSessionName(localName(it)).project }
							val spawnKeys = spawnPoints.map { localName(it) }.toSet()

							fun renderProject(projectKey: String, header: @Composable () -> Unit) {
								item(key = "spawn:$projectKey") { header() }
								items(byProject[projectKey].orEmpty().sortedWith(order), key = { "team:${it.name}" }) { team ->
									SessionCard(
										state = state,
										team = team,
										nested = true,
										onClick = hapticClick { onOpen(team.name) },
										onLongPress = { actionTeam = team },
									)
								}
							}

							for (sp in spawnPoints) {
								val proj = localName(sp)
								renderProject(proj) {
									SpawnPointHeader(
										project = proj,
										// A spawn-point is always available itself; its dot reflects whether any
										// session nested under it is live.
										online = byProject[proj].orEmpty().any { it.isLive },
										onSpawn = { spawnProject = proj },
									)
								}
							}
							// The host machine is a spawn point too, but it is not in the catalog (and the
							// daemon's reserved "host" slot is hidden), so inject it synthetically for YOUR OWN
							// gateway only - shown even with no host session yet, so the first one is spawnable.
							val hostInjected = !isPeer && key.gatewayId == state.localGatewayId
							if (hostInjected) {
								renderProject("host") {
									SpawnPointHeader(
										project = "host",
										online = byProject["host"].orEmpty().any { it.isLive },
										onSpawn = { spawnProject = "host" },
									)
								}
							}
							// A composite whose spawn-point is not currently in the catalog still needs a home
							// (excluding "host" when it was injected above, to avoid a duplicate header).
							val orphanProjects = byProject.keys - spawnKeys - (if (hostInjected) setOf("host") else emptySet())
							for (proj in orphanProjects.sorted()) {
								renderProject(proj) {
									SpawnPointHeader(project = proj, online = false, onSpawn = { spawnProject = proj })
								}
							}
							items(flatLoose, key = { "team:${it.name}" }) { team ->
								SessionCard(
									state = state,
									team = team,
									onClick = hapticClick { onOpen(team.name) },
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

/** The single status surface when the board has no sessions (the HealthHeader is hidden in this
 * state). Exactly one mutually exclusive branch renders, keyed on the connection state. A terminal
 * cause is checked before the enrolling/connecting spinners, so a hard error can never sit under a
 * "Setting up..." spinner, and it names the actual cause with a way forward. */
@Composable
private fun EmptyBoard(
	state: ChatState,
	onManage: () -> Unit,
	onAddGateway: () -> Unit,
	onHostHelp: () -> Unit,
	onRefresh: () -> Unit,
	onVerifyEnroll: (() -> Unit)? = null,
) {
	Column(
		Modifier.fillMaxSize().padding(32.dp),
		horizontalAlignment = Alignment.CenterHorizontally,
		verticalArrangement = Arrangement.Center,
	) {
		when {
			// A friend who just first-rooted has no host of their own yet (the invite omits gateway
			// ids by design), and the admin's own fresh provision first-roots too - so both land
			// here. Add a Gateway goes straight to the scanner; the friend with no computer yet still has
			// the body's "set up a computer" guidance.
			state.noGatewayState == NoGatewayState.AWAITING_HOST -> {
				Text("You're all set up", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody("Your Domain is ready. Set up a computer to run your agents, then add its Gateway here.")
				// An outstanding in-person trust compare (the admin who invited you is waiting) takes the
				// primary slot; adding a Gateway becomes the secondary step.
				if (onVerifyEnroll != null) {
					Spacer(Modifier.height(20.dp))
					Button(onClick = hapticClick(onVerifyEnroll)) { Text("Verify with the admin") }
					Spacer(Modifier.height(4.dp))
					TextButton(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				} else {
					Spacer(Modifier.height(20.dp))
					Button(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				}
			}
			// No Gateway admitted yet: the primary onboarding step goes straight to the scanner, with the
			// setup manual as the secondary step.
			state.noGatewayState == NoGatewayState.NEEDS_GATEWAY -> {
				Text("No Gateways yet", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody("The computer that runs your agents.")
				Spacer(Modifier.height(20.dp))
				Button(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				Spacer(Modifier.height(4.dp))
				TextButton(onClick = hapticClick(onHostHelp)) { Text("Running Gateway Setup") }
			}
			// A terminal failure that will not self-heal (secure storage, 401, admission rejected, or
			// an enrollment that gave up past the grace window). Name the actual cause from `error`
			// and offer a way forward - never "see the banner above", which is not on screen here.
			state.status == "error" -> {
				Text("Can't connect", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody(state.error ?: "Couldn't reach your Gateway.")
				Spacer(Modifier.height(20.dp))
				Button(onClick = hapticClick(onRefresh)) { Text("Try again") }
				Spacer(Modifier.height(4.dp))
				TextButton(onClick = hapticClick(onManage)) { Text("Gateways") }
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
			// Establishing the connection for the first time. A transient cause (no network, server
			// unreachable) is set on state.error by classifyConnError; surface it under the spinner so
			// a fresh friend with no network sees "Offline - no network", not a bare endless spinner.
			!state.connected -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Connecting...", color = MaterialTheme.colorScheme.onSurfaceVariant)
				state.error?.takeIf { it.isNotBlank() }?.let {
					Spacer(Modifier.height(8.dp))
					BoardBody(it)
				}
			}
			// Connected but the recent polls failed: online-ish, quietly reconnecting. Show the
			// classified cause when one is set, so a transient stall is named rather than silent.
			state.pollFailStreak > 0 -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Reconnecting...", color = MaterialTheme.colorScheme.onSurfaceVariant)
				state.error?.takeIf { it.isNotBlank() }?.let {
					Spacer(Modifier.height(8.dp))
					BoardBody(it)
				}
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
		state.health == ChatState.Health.SYNCING -> Color(0xFF0969DA) to (state.error ?: "Finishing enrollment...")
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
			Spacer(Modifier.width(6.dp))
			// This app's own version, right by the status, so the running build is visible at a glance.
			Text(
				"v${BuildConfig.VERSION_NAME}",
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				fontFamily = FontFamily.Monospace,
			)
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
/** The base board/thread word for a wire status, before any working/waking/login refinement. The
 * single owner of the status-word vocabulary; pair with presenceColor for the chip color. */
private fun statusWord(status: String): String = when (status) {
	"online" -> "live"
	"verifying" -> "verifying"
	"available" -> "available"
	else -> "ended"
}

@Composable
private fun presenceColor(presence: String): Color = when (presence) {
	"live" -> Color(0xFF2EA043)
	"working...", "waking...", "verifying" -> Color(0xFFD29922)
	"available" -> Color(0xFF0969DA)
	"check terminal" -> Color(0xFFDA3633)
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
			.hapticClickable(onClick = onToggle)
			.padding(horizontal = 4.dp, vertical = 8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		// The caret points down when open and up when collapsed.
		Icon(
			if (collapsed) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
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

/** A devcontainer project's spawn-point row: tapping it opens the session-name dialog to spawn a
 * new `project.session` chat. The project itself is never a chat (clean break). */
@Composable
private fun SpawnPointHeader(project: String, online: Boolean, onSpawn: () -> Unit) {
	Row(
		Modifier
			.fillMaxWidth()
			.clip(MaterialTheme.shapes.small)
			.hapticClickable(onClick = onSpawn)
			.padding(horizontal = 4.dp, vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(Icons.Default.Add, contentDescription = "New session", tint = MaterialTheme.colorScheme.primary)
		Spacer(Modifier.width(10.dp))
		Text(project, style = MaterialTheme.typography.titleSmall, fontFamily = FontFamily.Monospace)
		Spacer(Modifier.weight(1f))
		Text(
			if (online) "awake" else "asleep",
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
fun SessionCard(state: ChatState, team: Team, nested: Boolean = false, onClick: () -> Unit, onLongPress: () -> Unit) {
	val haptics = LocalHapticFeedback.current
	val strong = rememberStrongHaptic()
	val display = state.label(team.name, state.localGatewayId)
	val unread = state.unread[team.name] ?: 0
	val live = team.status == "online"
	val statusWord = statusWord(team.status)
	val statusColor = presenceColor(statusWord)
	// The clip keeps the ripple inside the card's rounded corners. A nested session card indents
	// under its spawn-point header.
	Card(
		modifier = Modifier.fillMaxWidth().padding(start = if (nested) 16.dp else 0.dp).clip(CardDefaults.shape).combinedClickable(
			onClick = {
				haptics.performHapticFeedback(HapticFeedbackType.LongPress)
				onClick()
			},
			onLongClick = {
				strong()
				onLongPress()
			},
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
			Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
				// A spinner while the session is coming up. The gateway reports "verifying" from the moment
				// a wake is in flight (spawn/wake) through the MCP handshake, so this covers the whole boot;
				// an online or plainly-asleep tile has none.
				if (team.status == "verifying") {
					CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = Color(0xFFD29922))
				}
				StatusChip(statusWord, statusColor)
				// Plugin-version chip: shown only when the agent's running plugin differs from
				// this app's expected version (BuildConfig.VERSION_NAME, derived from the same
				// package.json the build reads). Not a warning - the host auto-updates daily, so
				// a lag is benign and self-correcting. Neutral color, version only, no label.
				team.version?.let { v ->
					if (v != BuildConfig.VERSION_NAME) StatusChip("v$v", MaterialTheme.colorScheme.outline)
				}
				if (live && state.needsLogin(team.name)) {
					StatusChip("check terminal", Color(0xFFDA3633))
				} else if (live && state.working(team.name)) {
					StatusChip("working...", Color(0xFFD29922))
				}
				Spacer(Modifier.weight(1f))
				state.lastActivity(team.name)?.let {
					Text(
						relativeTime(it),
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
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
					TextButton(onClick = hapticClick(onRename), modifier = Modifier.fillMaxWidth()) { Text("Rename") }
				} else {
					Text(
						"Project names come from the Gateway and cannot be renamed.",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				TextButton(onClick = hapticClick(onForget), modifier = Modifier.fillMaxWidth()) { Text("Forget...") }
			}
		},
		confirmButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

@Composable
fun ConfirmDialog(title: String, body: String, confirmText: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(title) },
		text = { Text(body) },
		confirmButton = { TextButton(onClick = hapticClick(onConfirm)) { Text(confirmText) } },
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
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
	initialDraft: String,
	onDraftChange: (String) -> Unit,
	onRename: (String) -> Unit,
	onForget: () -> Unit,
	// Terminal view: only the host-agent and devcontainers are eligible. The peek/send are
	// team-bound suspend closures (the screen supplies the team).
	terminalEligible: Boolean,
	sessionStatus: String?,
	wakePending: Boolean,
	onWake: () -> Unit,
	terminalRefreshMs: Long,
	onTerminalPeek: suspend (sinceHash: String?) -> Result<com.atelier_nyaarium.switchboard.proto.ConsolePeekResult>,
	onTerminalSend: suspend (text: String?, key: String?, submit: Boolean) -> Unit,
) {
	// Seeded from the per-session saved draft and re-keyed on team, so switching tabs or
	// leaving and reopening a thread restores what you were typing. onDraftChange writes
	// every edit back to the session store.
	var draft by remember(team) { mutableStateOf(initialDraft) }
	var showMenu by remember { mutableStateOf(false) }
	var showRename by remember { mutableStateOf(false) }
	var confirmForget by remember { mutableStateOf(false) }
	var attachments by remember { mutableStateOf<List<Uri>>(emptyList()) }
	// The raw-tmux terminal view, toggled from the top bar; re-keyed when switching session. Defaults
	// on for a not-yet-live session so its boot is watchable without a manual toggle (see the call site).
	// Keyed off the known asleep/booting statuses so an unrecognized status opens chat, not terminal.
	var terminalMode by remember(team) {
		mutableStateOf(terminalEligible && sessionStatus in setOf(null, "available", "verifying"))
	}
	if (terminalMode) BackHandler { terminalMode = false }
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
			// `team` is the canonical address; show only the short local field
			// (`spawn` / `spawn.session`) as the rename context.
			team = localFieldOf(team),
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
					IconButton(onClick = hapticClick(onSessions)) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to sessions")
					}
				},
				actions = {
					if (terminalEligible) {
						IconButton(onClick = hapticClick { terminalMode = !terminalMode }) {
							if (terminalMode) {
								Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = "Back to chat")
							} else {
								Icon(Icons.Default.Terminal, contentDescription = "Terminal view")
							}
						}
					}
					IconButton(onClick = hapticClick { showMenu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More options") }
					DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
						if (canRename) {
							DropdownMenuItem(
								text = { Text("Rename") },
								onClick = hapticClick {
									showMenu = false
									showRename = true
								},
							)
						}
						DropdownMenuItem(
							text = { Text("Close tab") },
							onClick = hapticClick {
								showMenu = false
								onCloseTab(team)
							},
						)
						DropdownMenuItem(
							text = { Text("Forget...") },
							onClick = hapticClick {
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
						Tab(selected = i == selected, onClick = hapticClick { onGateway(t) }, text = { Text(tabLabel(t)) })
					}
				}
			}
			if (terminalMode) {
				TerminalView(
					team = team,
					refreshMs = terminalRefreshMs,
					wakePending = wakePending,
					sessionStatus = sessionStatus,
					onWake = onWake,
					onPeek = onTerminalPeek,
					onSend = onTerminalSend,
					modifier = Modifier.weight(1f).fillMaxWidth(),
				)
			} else {
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
							"verifying" -> "No messages yet. $label is connecting."
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
								IconButton(onClick = hapticClick { attachments = attachments - uri }) {
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
					onValueChange = { draft = it; onDraftChange(it) },
					label = { Text("Message") },
					modifier = Modifier.weight(1f),
				)
				// Attach stacks above Send in a narrow right column, so the text field
				// takes the remaining width.
				Column(Modifier.padding(start = 8.dp), horizontalAlignment = Alignment.End) {
					IconButton(onClick = hapticClick { picker.launch(arrayOf("*/*")) }) {
							Icon(Icons.Default.AttachFile, contentDescription = "Attach file")
						}
					FilledIconButton(
						enabled = draft.isNotBlank() || attachments.isNotEmpty(),
						onClick = hapticClick {
							onSend(draft, attachments)
							draft = ""
							onDraftChange("")
							attachments = emptyList()
						},
					) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send") }
				}
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
	SettingsRoute.NETWORKS -> "Domain & Trust"
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
	onYourDevices: () -> Unit,
	onFederation: () -> Unit,
	onClear: () -> Unit,
	onCloseSettings: () -> Unit,
) {
	// Settings opens from the pre-provision setup screen too. Before provisioning the repo is not
	// loaded, so the provisioned-only categories (Profile, Voice, Networks, Security) would NPE or
	// route into provisioned-only screens. Show ONLY the System section then, and treat a stale saved
	// sub-route as the hub so it can never render a provisioned-only screen unprovisioned.
	val provisioned = state.provisioned
	val effectiveRoute =
		if (!provisioned && route != SettingsRoute.HUB && route != SettingsRoute.SYSTEM) {
			SettingsRoute.HUB
		} else {
			route
		}
	val onBack = { if (effectiveRoute == SettingsRoute.HUB) onCloseSettings() else onRoute(SettingsRoute.HUB) }
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(settingsTitle(effectiveRoute)) },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			when (effectiveRoute) {
				SettingsRoute.HUB -> {
					if (provisioned) {
						SettingsRow(Icons.Default.Person, "Profile") { onRoute(SettingsRoute.PROFILE) }
						SettingsRow(Icons.Default.RecordVoiceOver, "Voice & TTS") { onRoute(SettingsRoute.VOICE) }
						SettingsRow(Icons.Default.Hub, "Domain & Trust") { onRoute(SettingsRoute.NETWORKS) }
						SettingsRow(Icons.Default.Lock, "Security") { onRoute(SettingsRoute.SECURITY) }
					}
					SettingsRow(Icons.Default.Tune, "System") { onRoute(SettingsRoute.SYSTEM) }
				}
				SettingsRoute.PROFILE -> ProfileSettings(state, repo, onSetDeviceName)
				SettingsRoute.VOICE -> SttsVoiceSection(repo)
				SettingsRoute.NETWORKS -> NetworksSettings(repo, onManage, onYourDevices, onFederation)
				SettingsRoute.SECURITY -> SecuritySettings(state, onToggleBiometric)
				SettingsRoute.SYSTEM -> SystemSettings(repo, onClear)
			}
		}
	}
}

/** A tappable hub row: a leading category icon, the label, and a trailing drill-in chevron.
 * The icons are decorative (the label announces the row), so contentDescription is null. */
@Composable
private fun SettingsRow(icon: ImageVector, label: String, onClick: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().hapticClickable(onClick = onClick).padding(vertical = 8.dp),
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
private fun ProfileSettings(state: ChatState, repo: ChatRepository, onSetDeviceName: (String) -> Unit) {
	val scope = rememberCoroutineScope()
	// The owner's display name (one per owner): what linked friends see them as. Owner-signed +
	// pushed to evie; it lives above the per-install device name. Seeded from state.displayName
	// (cache, refreshed from discovery) and re-seeded when that changes.
	var displayName by remember(state.displayName) { mutableStateOf(state.displayName) }
	var opStatus by remember { mutableStateOf("") }
	var opBusy by remember { mutableStateOf(false) }
	// A friend (one who first-rooted their own Domain) renaming before discovery has reported a
	// confirmed Domain id has nothing real to sign over, so evie would reject the rename ("Domain
	// not rooted" / "not owner-signed") as a raw "Could not save". Gate Save until discovery lands
	// the real Domain id. A device that never first-rooted (the admin) is not gated - its rename
	// signs over its own confirmed Domain once discovery reports it.
	val domainResolving = FriendOnboarding.renameAwaitsDiscovery(state.firstRooted, repo.confirmedDomainId())
	Text("Your name", style = MaterialTheme.typography.titleMedium)
	Text(
		"The name linked friends see you by.",
		style = MaterialTheme.typography.bodySmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedTextField(
			value = displayName,
			onValueChange = { displayName = it },
			singleLine = true,
			modifier = Modifier.weight(1f),
		)
		Button(
			enabled = displayName.isNotBlank() && displayName.trim() != state.displayName && !opBusy && !domainResolving,
			onClick = hapticClick {
				opBusy = true
				opStatus = ""
				scope.launch {
					repo.setDisplayName(displayName)
						.onSuccess { opStatus = "Saved." }
						.onFailure { opStatus = "Couldn't save: ${it.message?.take(120)}" }
					opBusy = false
				}
			},
			modifier = Modifier.padding(start = 8.dp),
		) { Text(if (opBusy) "..." else "Save") }
	}
	if (domainResolving) {
		Text("Loading your Domain...", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	} else if (opStatus.isNotEmpty()) {
		Text(opStatus, style = MaterialTheme.typography.bodySmall)
	}

	HorizontalDivider()

	var name by remember { mutableStateOf(state.deviceName) }
	Text("Device name", style = MaterialTheme.typography.titleMedium)
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, modifier = Modifier.weight(1f))
		Button(
			enabled = name.isNotBlank() && name != state.deviceName,
			onClick = hapticClick { onSetDeviceName(name.trim()) },
			modifier = Modifier.padding(start = 8.dp),
		) { Text("Save") }
	}
}

@Composable
private fun NetworksSettings(repo: ChatRepository, onManage: () -> Unit, onYourDevices: () -> Unit, onFederation: () -> Unit) {
	// Three distinct concerns kept apart: the gateways within YOUR network, the consoles signed in to
	// your account (Your devices), and linking with a friend's separate network (cross-Domain trust).
	Text("Your Domain", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onManage), modifier = Modifier.fillMaxWidth()) { Text("Gateways") }
	HorizontalDivider()
	Text("Account", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onYourDevices), modifier = Modifier.fillMaxWidth()) { Text("Your devices") }
	HorizontalDivider()
	Text("People", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onFederation), modifier = Modifier.fillMaxWidth()) { Text("Users") }
	HorizontalDivider()
	OwnerKeysCard(repo)
	OwnerBackupCard(repo)
}

@Composable
private fun SecuritySettings(state: ChatState, onToggleBiometric: (Boolean) -> Unit) {
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text("Biometric lock", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
		// Enabling the lock is direct; DISABLING it requires a scan, so a grabbed unlocked phone can't
		// drop the lock (then act against the owner key) without the owner present. With nothing enrolled
		// promptBiometric returns true, matching the "falls back to unlocked" posture.
		Switch(
			checked = state.biometricLock,
			onCheckedChange = { wantOn ->
				if (wantOn) onToggleBiometric(true)
				else scope.launch { if (activity != null && promptBiometric(activity)) onToggleBiometric(false) }
			},
		)
	}
	Text(
		"Require fingerprint or device PIN on app open. Falls back to unlocked if nothing is enrolled.",
		style = MaterialTheme.typography.bodySmall,
	)
}

/** System settings; the danger action (Revoke and Delete Domain) sits at the bottom behind a
 * confirm, so a wipe is two levels deep (Settings -> System) plus an explicit confirmation. The
 * action purges this owner's whole Domain from the servers, so it is hidden for an admin (who
 * purges via setup.sh) and shown only to a confirmed app-only owner (see canDeleteOwnDomain). */
@Composable
private fun SystemSettings(repo: ChatRepository, onClear: () -> Unit) {
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	var confirmDelete by remember { mutableStateOf(false) }
	var deleting by remember { mutableStateOf(false) }
	var deleteError by remember { mutableStateOf<String?>(null) }
	var wipedUnconfirmed by remember { mutableStateOf(false) }
	var refreshText by remember { mutableStateOf((repo.terminalRefreshMs / 1000.0).toString()) }
	BatteryExemptionRow()
	HorizontalDivider()
	AppUpdateRow()
	HorizontalDivider()
	Text("Terminal", style = MaterialTheme.typography.titleSmall)
	OutlinedTextField(
		value = refreshText,
		onValueChange = { refreshText = it },
		label = { Text("Refresh speed (seconds)") },
		singleLine = true,
		trailingIcon = {
			TextButton(onClick = hapticClick {
				val secs = refreshText.toDoubleOrNull()
				if (secs != null) repo.setTerminalRefreshMs((secs * 1000).toLong())
				// Always re-seed from the stored value: a valid entry reflects the clamp, and
				// invalid input visibly reverts to the last-saved value instead of looking saved.
				refreshText = (repo.terminalRefreshMs / 1000.0).toString()
			}) { Text("Save") }
		},
	)
	Text(
		"How often the terminal view re-captures the pane. Minimum 0.3s.",
		style = MaterialTheme.typography.bodySmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
	// Admins purge via setup.sh; an unconfirmed Domain (offline) hides it too, so an admin whose gateway
	// is down can't read the unknown state as "not admin" and delete everything (see canDeleteOwnDomain).
	if (repo.canDeleteOwnDomain()) {
		HorizontalDivider()
		Text("Danger", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
		OutlinedButton(
			onClick = hapticClick { deleteError = null; confirmDelete = true },
			colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
		) {
			Icon(Icons.Default.DeleteForever, contentDescription = null, modifier = Modifier.size(18.dp))
			Spacer(Modifier.width(4.dp))
			Text("Revoke and Delete Domain")
		}
		Text(
			"Purges your Domain from the servers and wipes this device. Voice settings are kept.",
			style = MaterialTheme.typography.bodySmall,
		)
	}
	if (confirmDelete) {
		AlertDialog(
			onDismissRequest = { if (!deleting) confirmDelete = false },
			title = { Text("Delete your Domain?") },
			text = {
				Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
					Text("This purges your Domain from the servers, not just this phone. It can't be undone.")
					Text("- Your Domain is removed from evie", style = MaterialTheme.typography.bodySmall)
					Text("- Every gateway + device is revoked", style = MaterialTheme.typography.bodySmall)
					deleteError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
				}
			},
			confirmButton = {
				TextButton(
					enabled = !deleting,
					onClick = hapticClick {
						scope.launch {
							// Biometric-gate this destructive owner-key action, mirroring revoke/admit.
							if (repo.state.value.biometricLock && (activity == null || !promptBiometric(activity))) return@launch
							deleting = true
							deleteError = null
							when (val outcome = repo.deleteDomain()) {
								DeleteDomainOutcome.Deleted -> {
									confirmDelete = false
									onClear()
								}
								DeleteDomainOutcome.WipedUnconfirmed -> {
									confirmDelete = false
									wipedUnconfirmed = true
								}
								is DeleteDomainOutcome.Rejected -> {
									deleting = false
									deleteError = outcome.error
								}
							}
						}
					},
				) { Text("Delete Domain") }
			},
			dismissButton = { TextButton(enabled = !deleting, onClick = hapticClick { confirmDelete = false }) { Text("Cancel") } },
		)
	}
	if (wipedUnconfirmed) {
		AlertDialog(
			onDismissRequest = { wipedUnconfirmed = false; onClear() },
			title = { Text("Couldn't reach the servers") },
			text = { Text("This device was wiped, but we couldn't confirm the purge. Ask the admin to purge it if it survived.") },
			confirmButton = { TextButton(onClick = hapticClick { wipedUnconfirmed = false; onClear() }) { Text("OK") } },
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

	// The voice + playback controls below stay hidden until a Test confirms BOTH the service and a
	// voice catalog, so a green status can never sit over a dimmed picker. Plain remember, NOT
	// rememberSaveable: the store is the durable source, and the secret never enters the
	// saved-instance-state Bundle (a half-typed key resetting on rotation is the right trade).
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
			onClick = hapticClick {
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
		OutlinedButton(onClick = hapticClick { pickerOpen = true }) { Text(current?.label ?: providerId.ifEmpty { "Provider" }) }
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
					onClick = hapticClick {
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
						onClick = hapticClick {
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
		onClick = hapticClick {
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
			Text("Pre-generate voice", style = MaterialTheme.typography.titleSmall)
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

	var autoPlay by remember { mutableStateOf(repo.sttsAutoPlay) }
	Column {
		Text("Auto-play new messages", style = MaterialTheme.typography.titleSmall)
		Text(
			"Speak a new message aloud the moment it arrives. Off is silent.",
			style = MaterialTheme.typography.bodySmall,
		)
		Spacer(Modifier.height(4.dp))
		val autoPlayOptions = listOf("off" to "Off", "title" to "Title", "summary" to "Summary", "full" to "Full")
		SingleChoiceSegmentedButtonRow {
			autoPlayOptions.forEachIndexed { index, (value, label) ->
				SegmentedButton(
					selected = autoPlay == value,
					onClick = hapticClick {
						autoPlay = value
						repo.sttsAutoPlay = value
					},
					shape = SegmentedButtonDefaults.itemShape(index = index, count = autoPlayOptions.size),
				) {
					Text(label)
				}
			}
		}
	}

	if (pickerOpen) {
		AlertDialog(
			onDismissRequest = { pickerOpen = false },
			confirmButton = {},
			title = { Text("Provider") },
			text = {
				Column {
					for (p in providers) {
						TextButton(onClick = hapticClick {
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

/** One-press self-update: download the chosen variant's APK straight from the public
 * GitHub release, then launch the installer. The variant dropdown lets the user
 * deliberately cross-flash debug <-> release (same signing key, so it is a reinstall);
 * a same-variant pick is the normal newer-only update. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppUpdateRow() {
	val context = LocalContext.current
	val scope = rememberCoroutineScope()
	var status by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	// Defaults to the running variant; switching it and pressing Update cross-flashes.
	var variant by remember { mutableStateOf(AppUpdater.currentVariant()) }
	var variantMenuOpen by remember { mutableStateOf(false) }
	val variants = listOf("debug", "release")
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Column(Modifier.weight(1f)) {
			Text("App update", style = MaterialTheme.typography.titleMedium)
			Text(
				"v${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		ExposedDropdownMenuBox(
			expanded = variantMenuOpen,
			onExpandedChange = { if (!busy) variantMenuOpen = it },
			modifier = Modifier.padding(end = 8.dp).widthIn(max = 130.dp),
		) {
			OutlinedTextField(
				value = variant,
				onValueChange = {},
				readOnly = true,
				enabled = !busy,
				label = { Text("Variant") },
				trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = variantMenuOpen) },
				singleLine = true,
				modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
			)
			ExposedDropdownMenu(expanded = variantMenuOpen, onDismissRequest = { variantMenuOpen = false }) {
				for (v in variants) {
					DropdownMenuItem(
						text = { Text(v) },
						onClick = hapticClick {
							variant = v
							variantMenuOpen = false
						},
					)
				}
			}
		}
		Button(
			enabled = !busy,
			onClick = hapticClick {
				busy = true
				status = "Checking for updates..."
				val chosen = variant
				scope.launch(kotlinx.coroutines.Dispatchers.IO) {
					val result = AppUpdater.downloadAndStage(context, chosen)
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
			Button(onClick = hapticClick {
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

// The gateway's displayLabel/sessionLabel wire schema caps both at 64 characters; enforced
// client-side too so pasting a long string reads as "can't type more" rather than a confusing
// server-side rejection once submitted.
private const val SESSION_LABEL_MAX_CHARS = 64

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
					onValueChange = { if (it.length <= SESSION_LABEL_MAX_CHARS) name = it },
					label = { Text("Display name") },
					singleLine = true,
				)
			}
		},
		confirmButton = { TextButton(onClick = hapticClick { onSave(name) }) { Text("Save") } },
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

/** Name and spawn a new session in a spawn-point project. The label is free-form: the gateway mints
 * the session id, so the field accepts any text and the spawn button is enabled once it is non-blank. */
@Composable
fun SpawnDialog(project: String, onSpawn: (String) -> Unit, onDismiss: () -> Unit) {
	// A free-form label: the gateway mints the session id, so the label is not slug-constrained.
	var name by remember { mutableStateOf("") }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("New session in $project") },
		text = {
			OutlinedTextField(
				value = name,
				onValueChange = { if (it.length <= SESSION_LABEL_MAX_CHARS) name = it },
				label = { Text("Session name") },
				singleLine = true,
			)
		},
		confirmButton = {
			TextButton(enabled = name.isNotBlank(), onClick = hapticClick { onSpawn(name.trim()) }) { Text("Spawn") }
		},
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
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
