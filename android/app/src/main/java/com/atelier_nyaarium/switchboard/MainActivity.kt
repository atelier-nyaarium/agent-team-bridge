package com.atelier_nyaarium.switchboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.board.BoardEditScreen
import com.atelier_nyaarium.switchboard.board.BoardScreen
import com.atelier_nyaarium.switchboard.board.BoardSource
import com.atelier_nyaarium.switchboard.board.GroupKey
import com.atelier_nyaarium.switchboard.board.flattenBoard
import com.atelier_nyaarium.switchboard.plugins.TappedLink
import com.atelier_nyaarium.switchboard.plugins.Plugins
import com.atelier_nyaarium.switchboard.proto.FocusIntent
import com.atelier_nyaarium.switchboard.proto.isComposite
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

	/** The bubble or the transport notification asked for the queue list; consumed by App. */
	private val openQueueRequest = mutableStateOf(false)

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		DebugLog.init(this)
		val repo = Repo.get(this)
		val injected = intent.getStringExtra("provisioning_b64")
			?.let { runCatching { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }.getOrNull() }
		consume(intent)
		setContent {
			val colors = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
			MaterialTheme(colorScheme = colors) { App(repo, injected, openTeamRequest, openQueueRequest) }
		}
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		setIntent(intent)
		consume(intent)
	}

	/**
	 * Read the one-shot extras and REMOVE them.
	 *
	 * Removal is the load-bearing half. The intent outlives the Activity, so every configuration
	 * change re-runs onCreate against it - and an extra left in place is not a request, it is a
	 * standing instruction to reopen the sheet and re-jump the thread on every rotation, forever.
	 */
	private fun consume(intent: Intent) {
		intent.getStringExtra(SwitchboardService.EXTRA_OPEN_TEAM)?.let {
			openTeamRequest.value = it
			intent.removeExtra(SwitchboardService.EXTRA_OPEN_TEAM)
		}
		if (intent.getBooleanExtra(SwitchboardService.EXTRA_OPEN_QUEUE, false)) {
			openQueueRequest.value = true
			intent.removeExtra(SwitchboardService.EXTRA_OPEN_QUEUE)
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun App(
	repo: ChatRepository,
	injectedBlob: String?,
	openTeamRequest: MutableState<String?>,
	openQueueRequest: MutableState<Boolean>,
) {
	val state by repo.state.collectAsState()
	val scope = rememberCoroutineScope()
	val context = LocalContext.current
	val activity = context as? FragmentActivity
	var openTeam by remember { mutableStateOf<String?>(null) }
	// Bumped on every genuine "open this thread" gesture (notification tap, board tap, an
	// already-selected tab tapped again) - never on an ordinary message arrival. Keys the reveal
	// effect in ThreadWebView so it re-snaps to the first unread row on each such open, even when
	// `openTeam` itself is unchanged (re-tapping a notification for the thread already on screen).
	var openNonce by remember { mutableStateOf(0) }
	// (team, at) a queue tile asked to land on. Cleared once the reveal has been handed to the renderer,
	// so re-opening the same thread later does not silently re-scroll to an old message.
	var revealAt by remember { mutableStateOf<Pair<String, Long>?>(null) }
	// Read here as well as in the sheet: the board's own way in has to appear the moment a run starts
	// and go when it ends, and that is a settled-state question like every other one in this feature.
	// Keyed on the revision so the failures scan runs when the queue changes rather than on every
	// unrelated recomposition of the board.
	val queueRevision by repo.playback.queueRevision.collectAsState()
	val queueState = remember(queueRevision) {
		val (active, paused) = repo.playback.transportState()
		when {
			// The alert outranks the run: a message that was never spoken is the thing worth showing,
			// and it is the state that outlives everything else.
			repo.playback.failedRows().isNotEmpty() -> QueueGlance.ALERT
			active && paused -> QueueGlance.PAUSED
			active -> QueueGlance.SPEAKING
			else -> QueueGlance.IDLE
		}
	}
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
	// The open task-board entry's full-screen editor, as (gatewayId, entryId).
	var editEntry by remember { mutableStateOf<Pair<String, String>?>(null) }
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

	// The plugin framework boots with the app (not on first Settings open): an enabled plugin's
	// contributions must be live for every surface that consults a registry, not only after the
	// user happens to visit the toggle screen.
	val pluginManager = remember { Plugins.get(context) }

	// WebView pool lives at App scope (never leaves composition) so each thread's
	// renderer survives Sessions round-trips and tab switches. Pruned to open tabs;
	// destroyed with the Activity.
	val rendererPool = remember { ThreadRendererPool(context.applicationContext) }
	rendererPool.onRetry = { team, id -> repo.command { retrySend(team, id) } }
	rendererPool.onCancel = { team, id -> repo.cancelFailedSend(team, id) }
	// Attribute a message's sender by its human label (a notice's `from` is a canonical address).
	// Reads the live state at render time so a rename reflects without rebuilding the pool.
	rendererPool.resolveFrom = { addr -> repo.state.value.label(addr) }
	// Attribute the local user's own messages by their account display name instead of "you".
	rendererPool.selfLabel = { repo.state.value.displayName }
	// Attachment taps open the in-app viewer; the path is re-validated against the
	// attachments root before any file is touched. The wire mime (what the agent
	// declared) is preferred over extension guessing.
	var viewer by remember { mutableStateOf<OpenAttachment?>(null) }
	rendererPool.onAttachmentTap = { tapTeam, rel ->
		Attachments.resolve(context.filesDir, rel)?.let { file ->
			// Drafts as well as threads: a picked file belongs to no message, so a threads-only
			// scan leaves the viewer's rows blank for exactly the files a pre-send check is for.
			val wire = state.threads.values.asSequence().flatten()
				.flatMap { it.files.asSequence() }
				.plus(state.drafts.values.asSequence().flatMap { it.files.asSequence() })
				.firstOrNull { it.src?.endsWith("/$rel") == true }
			val mime = wire?.mime?.takeIf { it.isNotEmpty() } ?: mimeForFile(file)
			// A plugin (e.g. the Designer) may claim a tapped attachment and open it in its own
			// viewer; only fall back to the generic attachment viewer when none does. The team is
			// the tapped thread's own (bound per-renderer), not the ambient on-screen team.
			val claimed = pluginManager.host.attachmentOpeners.anyCaught(onError = ::logPluginThrow) {
				it.tryOpen(context, tapTeam, rel, mime, file.name)
			}
			if (!claimed) {
				// Size and mtime come from the WIRE, not from the local copy: the file on disk was
				// written by the fetch, so its own mtime is when it landed here, not the age the
				// sender meant to carry. Absent when the sender never stamped it, and the row hides.
				viewer = OpenAttachment(file, file.name, mime, rel, wire?.size, wire?.modifiedAt)
			}
		}
	}
	// A plugin may decorate its own attachment chips (e.g. the Designer's card title); the first
	// non-null decoration wins, everything else renders the plain chip. Containment matters here:
	// this runs on every sync of every open thread, so a throwing decorator must cost only its own
	// decoration, never the transcript render.
	rendererPool.decorateFile = { team, file ->
		pluginManager.host.attachmentChipDecorators.firstNotNullCaught(onError = ::logPluginThrow) {
			it.decorate(team, file)
		}
	}
	// In-thread Play buttons render only when STTS is provisioned; taps speak the full tier, and the
	// player's now-playing pushes glyph state back. Re-evaluated per recomposition so provisioning
	// in-session lights the buttons for renderers built afterward.
	rendererPool.playEnabled = repo.sttsReady()
	rendererPool.onPlayTap = { team, at ->
		// A tap on an audible message stops it; otherwise it JOINS the queue at FULL rather than
		// starting alongside it. A row that is already queued renders unpressable, so a tap can only
		// ever arrive for one that is idle or playing.
		if (repo.playback.isMessagePlaying(team, at)) {
			repo.playback.stopMessage(team, at)
		} else {
			repo.command { playback.enqueueForPlay(team, at, SttsPlayer.Tier.FULL, announceRun = false) }
		}
	}
	rendererPool.onReadUpTo = { team, id, at -> repo.readUpTo(team, id, at) }
	// Links: a tap on a standard anchor routes through the scheme dispatcher (openLink); the
	// context menu (long-press on a standard anchor, or tap on an unhandled-protocol link)
	// shows the URL with Open enabled only when the dispatcher can actually open it.
	var linkMenu by remember { mutableStateOf<Pair<String, String>?>(null) }
	// Set only when a plugin was offered this link and declined it, so the dialog can explain itself.
	var linkMenuNote by remember { mutableStateOf<String?>(null) }
	rendererPool.onLinkTap = { team, url -> openLink(context, team, url) }
	rendererPool.onLinkMenu = { team, url ->
		linkMenuNote = null
		linkMenu = team to url
	}
	// A tapped link whose scheme a plugin claims. The framework resolves the ROW first, so a handler
	// receives that row's own files rather than a row id it would have to trust and resolve itself.
	// The same ref in two messages points at two different snapshots, which is why the row's `at`
	// rides along. Unresolvable, unclaimed, or declined all fall through to the link menu: never a
	// crash, never a silent no-op, never a wrong-row open.
	rendererPool.onClaimedLinkTap = { team, rowId, rowAt, url ->
		val row = repo.state.value.threads[team]?.firstOrNull { it.id == rowId && it.at == rowAt }
		val claimed = row != null &&
			pluginManager.host.linkHandlers.anyCaught(onError = ::logPluginThrow) {
				it.tryOpen(context, TappedLink(team, url, row.files))
			}
		if (!claimed) {
			linkMenuNote = "No code snapshot is attached to this message."
			linkMenu = team to url
		}
	}
	// Claimed schemes decide which links render as live rather than broken; re-pushed on a toggle.
	rendererPool.handledSchemes = pluginManager.host.linkHandlers.values().map { it.scheme }
	DisposableEffect(Unit) {
		// Fires on the player's daemon thread; the pool's renderer map is
		// main-owned, so hop through the composition scope (main-dispatched).
		// An event is a nudge to re-read, not a fact to accumulate. Asking the repository what is true
		// now means this cannot drift from it - the version that tracked generations itself was wrong
		// twice, once blanking a row still playing and once stranding one that had ended.
		val glyphs = repo.stts.addListener { event ->
			val team = event.team
			scope.launch { rendererPool.setPlayStates(team, repo.playback.playStatesFor(team)) }
		}
		onDispose { repo.stts.removeListener(glyphs) }
	}
	// And again once the queue has SETTLED. A raw playback event fires before the terminal it reports
	// has advanced the queue, so a row painted from it can show the state from just before the advance
	// with no later event to correct it - the same pre-settle race the transport hit, answered the same
	// way. Every open tab, since one terminal can start a message in a different thread.
	LaunchedEffect(Unit) {
		repo.playback.queueRevision.collect {
			for (team in repo.state.value.openTabs) rendererPool.setPlayStates(team, repo.playback.playStatesFor(team))
		}
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
			repo.enroll.pendingEnrolleeCeremony()?.let {
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
	androidx.lifecycle.compose.LifecycleStartEffect(Unit) {
		repo.onForeground()
		rendererPool.setVisible(true)
		repo.command { reconcilePending() }
		onStopOrDispose {
			repo.onBackground()
			rendererPool.setVisible(false)
		}
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
			editEntry = null
			openTeam = opened
			// A genuine open gesture - re-snap to the first unread row even if this thread is
			// already the one on screen (openTeam unchanged does not recompose ThreadWebView).
			openNonce++
			openTeamRequest.value = null
		}
	}

	// Declares "board" focus while the board (not a thread/terminal) is what's on screen - the
	// Gateway's intent tracker ramps every LIVE session's daemon-derivation cadence while this
	// device is watching, so board tiles reflect a working/needsLogin flip from the presence
	// plane (Team.working/needsLogin) with no per-session peek of this device's own. Superseded by
	// TerminalView's own terminal-focus declaration while a specific session's terminal is open;
	// left alone (not reset here) while a non-terminal thread is open, since nothing daemon-drivable
	// is showing either way.
	LaunchedEffect(openTeam) {
		if (openTeam == null) repo.declareFocus(FocusIntent(screen = "board"))
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
			showYourDevices || showApproval || editEntry != null,
	) {
		when {
			editEntry != null -> editEntry = null
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
					repo.enroll.markEnrolleeCeremonyDone()
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
					repo.enroll.adminEnrollContext(hostTenant!!)?.let {
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
				plugins = pluginManager,
				route = settingsRoute,
				onRoute = { settingsRoute = it },
				onSetDeviceName = { repo.command { setDeviceName(it) } },
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
					// The Domain-delete transaction (DomainAdminOps.deleteDomain) owns the local wipe; drop
					// plugin device state (e.g. the Designer index) alongside it, then navigate home.
					pluginManager.host.accountWipeHandlers.forEachCaught(onError = ::logPluginThrow) { it.onWipe(context) }
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
				onProvision = { repo.command { provision(it) } },
				onSettings = { showSettings = true },
			)
		// Ahead of openTeam: tapping an entry from the thread strip must show the editor, not the
		// thread underneath it.
		editEntry != null -> {
			val (gw, id) = editEntry!!
			BoardEditScreen(state = state, repo = repo, gatewayId = gw, entryId = id, onClose = { editEntry = null })
		}
		openTeam != null -> {
			// Devcontainer names are the project identity; only loose peers take labels.
			val session = state.sessions().firstOrNull { it.name == openTeam }
			val kind = session?.kind
			// Rename only when positively known loose; an unknown kind (team gone
			// from the list) stays un-renameable rather than defaulting open.
			val presence = when {
				session == null -> null
				session.status == "online" -> when {
					// Outranks "working...": the session reads as online while the dialog holds its pane,
					// so without this a blocked session would present as healthy.
					session.limitBlocked == true -> "limit hit"
					state.needsLogin(session.name) -> "check terminal"
					state.working(session.name) -> "working..."
					else -> "live"
				}
				session.status == "available" -> if (state.working(session.name)) "waking..." else "available"
				else -> statusWord(session.status)
			}
			// Everything a forget tears down BESIDE the repo's own record. Shared by both forget paths so
			// the plugin sweep and the notification cancels cannot end up on only one of them. The repo
			// calls it once the forget has landed, never before.
			val forgetTeardown = { forgotten: String ->
				pluginManager.host.threadForgetHandlers.forEachCaught(onError = ::logPluginThrow) { it.onForget(context, forgotten) }
				SwitchboardService.cancelTeamNotification(context, forgotten)
				SwitchboardService.cancelScheduledSendFailedNotification(context, forgotten)
				// Only if THIS thread is still the open one: a slow disposition can finish long after
				// the owner has moved on, and closing whatever they opened since is not the ask.
				if (openTeam == forgotten) openTeam = null
			}
			// This session's board slice for the strip. A non-route session's half is cadence-fresh
			// through board_read, so entering its thread refreshes it (one of the three triggers).
			val boardOn = pluginManager.isActive("taskboard")
			val boardGateway = repo.boardOps.boardGatewayOf(openTeam)
			// Keyed on boardGateway too: opening from a notification composes the thread before the
			// teams roster lands, and without that key the non-route read would never fire at all.
			LaunchedEffect(openTeam, boardOn, boardGateway) {
				if (boardOn && repo.boardOps.isNonRouteSession(openTeam!!)) repo.boardOps.refreshBoard()
			}
			val boardRevision by repo.board.revision
			// boardGateway is a key here for the same reason the effect above takes it: it answers the
			// route Gateway until the roster lands, and a failed read never bumps the revision.
			val boardStripFor = remember(openTeam, boardRevision, boardOn, boardGateway) {
				if (!boardOn) null
				else {
					val key = GroupKey(boardGateway, repo.board.sessionKeyOf(openTeam!!))
					flattenBoard(listOf(BoardSource(boardGateway, repo.board.mergedEntries(boardGateway))))
						.sessions.firstOrNull { it.key == key }
				}
			}
			val boardLiveLineFor = remember(openTeam, boardRevision, boardOn, boardGateway) {
				if (boardOn) repo.board.liveLine(boardGateway, openTeam!!) else null
			}
			ThreadScreen(
				team = openTeam!!,
				label = tabLabelFor(state, openTeam!!),
				presence = presence,
				tabs = state.openTabs,
				tabLabel = { tabLabelFor(state, it) },
				onReorderTabs = repo::reorderTabs,
				messages = state.threads[openTeam].orEmpty(),
				// During a wake the notice card already explains the wait, so suppress the auto-retry
				// connection banner (the transient "... - retrying" causes). A real error (terminal
				// causes never end in "retrying") still surfaces.
				error = state.error?.takeUnless { presence == "waking..." && it.endsWith("retrying") },
				rendererPool = rendererPool,
				canRename = kind == "loose",
				openNonce = openNonce,
				boardStrip = boardStripFor,
				boardLiveLine = boardLiveLineFor,
				revealAt = revealAt,
				onRevealed = { revealAt = null },
				unreadBoundary = repo::unreadBoundary,
				onGateway = { t ->
					// A tab switch onto a DIFFERENT thread is a genuine open (re-snap to its first
					// unread); re-tapping the already-active tab is a no-op tap today, unchanged.
					if (t != openTeam) openNonce++
					openTeam = t
				},
				onCloseTab = { t ->
					// Move off the closing tab before dropping it from openTabs, so the
					// retain() pass that destroys its renderer never targets the one
					// still on screen.
					if (t == openTeam) openTeam = state.openTabs.firstOrNull { it != t }
					repo.closeTab(t)
				},
				onSessions = { openTeam = null },
				onSend = { text, uris -> repo.command { send(openTeam!!, text, uris) } },
				draft = state.drafts[openTeam!!] ?: Draft(),
				onDraftTextChange = { repo.setDraftText(openTeam!!, it) },
				onAddDraftFiles = { uris -> repo.command { addDraftFiles(openTeam!!, uris) } },
				onRemoveDraftFile = { src -> repo.removeDraftFile(openTeam!!, src) },
				// A draft file resolves the same way a tapped transcript attachment does, so the
				// viewer sees one shape of OpenAttachment no matter which surface opened it.
				onOpenDraftFile = { file ->
					val rel = Attachments.relOf(file.src)
					val resolved = Attachments.fileFor(context.filesDir, file.src)
					if (rel != null && resolved != null) {
						viewer = OpenAttachment(
							resolved,
							file.name,
							file.mime,
							rel,
							file.size,
							file.modifiedAt,
							// Only reachable from here: a draft is the one place a file has a source
							// the user might want to check before it goes anywhere.
							location = state.drafts[openTeam!!]?.locations?.get(file.src),
						)
					}
				},
				onAppendDraftText = { insert -> repo.appendDraftText(openTeam!!, insert) },
				onClearDraft = { repo.clearDraft(openTeam!!) },
				scheduledSend = state.scheduledSends[openTeam!!],
				waking = openTeam!! in state.wakingTeams,
				onScheduleSend = { text, uris, at -> repo.scheduleSend(openTeam!!, text, uris, at) },
				onReschedule = { at -> repo.rescheduleSend(openTeam!!, at) },
				onCancelScheduledSend = { repo.cancelScheduledSendForEdit(openTeam!!) },
				onRename = { name -> repo.command { rename(openTeam!!, name) } },
				onForget = {
					val forgotten = openTeam!!
					repo.forget(forgotten)
					forgetTeardown(forgotten)
				},
				// The board gate: the same decision the sessions list asks for, so the two surfaces
				// cannot disagree about when a forget is safe.
				undoneTasks = if (boardOn) repo.board.undoneCount(boardGateway, openTeam!!) else 0,
				onForgetWithTasks = { cancelThem ->
					val forgotten = openTeam!!
					repo.boardOps.forgetWithBoardDisposition(forgotten, cancelThem) { forgetTeardown(forgotten) }
				},
				// A LOCAL composite session has a daemon-drivable pane; remote-Gateway is gated off in v1,
				// and the host machine's terminal is reached through the dedicated "host" target.
				terminalEligible = isComposite(localFieldOf(openTeam!!)) &&
					(session?.gatewayId.isNullOrEmpty() || session?.gatewayId == state.localGatewayId),
				// The terminal view (docker-logs then tmux) opens by default only for a session already
				// known to be stuck (sessionNeedsLogin below) - a plain booting session opens to chat
				// instead, since there is nothing to watch until it either comes up or gets stuck. The
				// Wake button reattaches an asleep one.
				sessionStatus = session?.status,
				// Daemon-derived (presence plane), so it can be true even before "online" - a peeked pane
				// stuck at a login prompt is knowable while the MCP handshake is still pending.
				sessionNeedsLogin = session?.needsLogin == true,
				// Also daemon-derived, so the chat view learns about a block with no peek of its own.
				sessionLimitBlocked = session?.limitBlocked == true,
				sessionLimitDetail = session?.limitDetail,
				// A "verifying" session is coming up (a wake in flight, through the MCP handshake), so the
				// terminal seeds "Waking..." rather than "asleep"; a plain asleep session reads "asleep".
				wakePending = session?.status == "verifying",
				onWake = { repo.wakeSession(openTeam!!) },
				onRelaunch = { repo.relaunchSession(openTeam!!) },
				terminalRefreshMs = repo.terminalRefreshMs,
				onTerminalPeek = { hash -> repo.peekTerminal(openTeam!!, hash) },
				onTerminalSend = { text, key, submit -> repo.tmuxSend(openTeam!!, text, key, submit) },
				onResumeAfterLimit = { repo.resumeAfterLimit(openTeam!!) },
				onFocusChange = repo::declareFocus,
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
			// Folded ONCE per board revision, not per card per recomposition: each call replays the
			// whole pending queue over the whole snapshot, and the session list recomposes on every
			// poll (unread, snippet, presence).
			val boardOnHere = pluginManager.isActive("taskboard")
			val boardRevisionForCards by repo.board.revision
			val boardLines = remember(boardRevisionForCards, state.teams, boardOnHere) {
				if (!boardOnHere) emptyMap()
				else state.teams.associate { it.name to repo.board.liveLine(repo.boardOps.boardGatewayOf(it.name), it.name) }
			}
			// Alongside the lines rather than inside the card, on the same revision key: the list
			// recomposes on every poll and a per-card flatten would rebuild every session's tree each time.
			val boardBranches = remember(boardRevisionForCards, state.teams, boardOnHere) {
				if (!boardOnHere) emptyMap()
				else state.teams.mapNotNull { team ->
					val line = boardLines[team.name] ?: return@mapNotNull null
					team.name to repo.board.cardBranch(repo.boardOps.boardGatewayOf(team.name), team.name, line.currentId)
				}.toMap()
			}
			MainTabsScreen(
				state = state,
				boardEnabled = pluginManager.isActive("taskboard"),
				snackbarHostState = snackbarHostState,
				onRefresh = {
					repo.command { refreshTeams() }
					// The board's non-route columns have no live plane, so Refresh is their only
					// manual retry.
					repo.boardOps.refreshBoard()
				},
				onSettings = {
					settingsRoute = SettingsRoute.HUB
					showSettings = true
				},
				queueState = queueState,
				onQueue = { openQueueRequest.value = true },
				board = { modifier, goToSessions ->
					BoardScreen(
						state = state,
						repo = repo,
						onOpenEntry = { gw, id -> editEntry = gw to id },
						onSaved = goToSessions,
						modifier = modifier,
					)
				},
				sessions = { modifier ->
					SessionsScreen(
						state = state,
						modifier = modifier,
						onRefresh = { repo.command { refreshTeams() } },
						onManage = { showManage = true },
						onAddGateway = { showAddGateway = true },
						onHostHelp = { showHostHelp = true },
						onOpen = { team ->
							openTeam = repo.openThread(team)
							openNonce++
						},
						onRename = { team, name -> repo.command { rename(team, name) } },
						onForget = { team ->
							pluginManager.host.threadForgetHandlers.forEachCaught(onError = ::logPluginThrow) {
								it.onForget(context, team)
							}
							repo.forget(team)
							SwitchboardService.cancelTeamNotification(context, team)
							SwitchboardService.cancelScheduledSendFailedNotification(context, team)
						},
						// Fire the create and stay on the board: the gateway adopts the session's record
						// synchronously and bumps the presence plane with it, so its own tile appears via
						// this device's own next poll (spinner while it boots) with no separate refresh.
						// Tapping the tile opens its terminal view. A failure surfaces as a Snackbar.
						onSpawn = { project, label, workdir -> repo.command { spawnSession(project, label, workdir) } },
						onListDirs = { path -> repo.listDirs(path) },
						// Launch the enrollee compare from the empty board when one is still owed (the
						// device rooted an enroll invite but has not completed the in-person trust step).
						onVerifyEnroll = (if (state.provisioned) repo.enroll.pendingEnrolleeCeremony() else null)
							?.let { c -> { enrolleeCeremonyCtx = c } },
						boardLine = { team -> boardLines[team.name] },
						boardBranch = { team -> boardBranches[team.name] },
						undoneFor = { team ->
							if (pluginManager.isActive("taskboard")) {
								repo.board.undoneCount(repo.boardOps.boardGatewayOf(team.name), team.name)
							} else 0
						},
						onForgetWithTasks = { team, cancelThem ->
							// Plugin state and notifications die only once the forget has landed: a
							// session whose forget never reached its Gateway still exists, and it must
							// not come back with its design cards already destroyed.
							repo.boardOps.forgetWithBoardDisposition(team, cancelThem) {
								pluginManager.host.threadForgetHandlers.forEachCaught(onError = ::logPluginThrow) {
									it.onForget(context, team)
								}
								SwitchboardService.cancelTeamNotification(context, team)
								SwitchboardService.cancelScheduledSendFailedNotification(context, team)
							}
						},
					)
				},
			)
		}
	}

	// The queue list. Opened by the bubble and by the transport notification's body, so it is reachable
	// whether or not the overlay permission was ever granted.
	// NOT while locked. Every other overlay down here is reached by an in-app gesture, which already
	// implies an unlocked session; this one arrives by INTENT from the notification or the bubble, so
	// without the guard a tap on a locked phone would put queued message titles and working transport
	// controls on top of the lock screen.
	if (openQueueRequest.value && !locked) {
		QueueSheetHost(
			repo = repo,
			onDismiss = { openQueueRequest.value = false },
			onJump = { entry ->
				// Through the same request the notification tap uses, so the jump inherits its whole
				// open gesture - dismissing masking surfaces, selecting the tab, re-snapping - rather
				// than re-implementing a partial copy of it.
				revealAt = entry.team to entry.at
				openTeamRequest.value = entry.team
				openQueueRequest.value = false
			},
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

	linkMenu?.let { (team, url) ->
		AlertDialog(
			onDismissRequest = { linkMenu = null },
			title = { Text("Link") },
			text = {
				Column {
					Text(url)
					// A claimed scheme that reached this dialog was offered to its plugin and declined,
					// so say why rather than leaving it indistinguishable from an unhandled link.
					if (linkMenuNote != null) {
						Spacer(Modifier.height(8.dp))
						Text(linkMenuNote!!, style = MaterialTheme.typography.bodySmall)
					}
				}
			},
			confirmButton = {
				// Greyed out for a scheme the dispatcher cannot open (an unhandled protocol's
				// menu is copy-only until a handler exists).
				TextButton(
					enabled = linkOpenable(url),
					onClick = hapticClick {
						openLink(context, team, url)
						linkMenu = null
					},
				) { Text("Open") }
			},
			dismissButton = {
				TextButton(onClick = hapticClick {
					copyLinkToClipboard(context, url)
					linkMenu = null
				}) { Text("Copy URL") }
			},
		)
	}
}

/** Registry onError sink shared by every plugin-registry consultation site: a claim that threw
 * is logged and skipped, never fatal. */
private fun logPluginThrow(message: String, err: Throwable) {
	DebugLog.log("Plugins", "$message: $err")
}

internal fun readClipboard(context: Context): String? {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
	return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
}

/** The schemes [openLink] can actually open today. Also drives the link menu's Open button state
 * and mirrors the renderer's own standard-vs-unhandled split (markdown-link-rules.js): a scheme
 * outside this set renders as an inert red link whose menu offers Copy only. */
private val OPENABLE_SCHEMES = setOf("http", "https", "mailto")

private fun linkOpenable(url: String): Boolean = Uri.parse(url).scheme?.lowercase() in OPENABLE_SCHEMES

/** Every link activation (tap, or Open from the context menu) funnels here, keyed by scheme, so a
 * custom protocol (e.g. a host-project file reference) becomes a new branch without touching the
 * renderer or pool. `team` is the thread the link was tapped in - unused by the web schemes, but a
 * project-scoped protocol needs it to know which session's host it acts on. */
private fun openLink(context: Context, team: String, url: String) {
	when (Uri.parse(url).scheme?.lowercase()) {
		in OPENABLE_SCHEMES -> runCatching {
			context.startActivity(
				Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
			)
		}
		else -> {}
	}
}

private fun copyLinkToClipboard(context: Context, url: String) {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
	cm.setPrimaryClip(ClipData.newPlainText("link", url))
}

/** True once the text is a JSON object with the fields a Provisioning needs. */
internal fun looksProvisionable(s: String): Boolean = runCatching {
	val j = org.json.JSONObject(s.trim())
	j.has("apiUrl") && j.has("saToken") && j.has("caPem")
}.getOrDefault(false)

/** The session-board grouping key: the full (Domain, Gateway) pair. A gateway id is
 * unique only within a Domain, so two linked friend Domains running an identically-named
 * gateway must group separately rather than merge. */
internal data class GatewayGroupKey(val domainId: String, val gatewayId: String)

// Cap the rendered voice menu: some providers ship hundreds of voices, and the
// field's text filters the rest into view.
/** A provisioning blob is small JSON; anything larger is a mis-picked file. */
internal const val MAX_PROVISION_BLOB_BYTES = 1_000_000L

internal const val MAX_VOICE_MENU_ITEMS = 60

/** The Voice connection's single honest state, shown on the settings status line.
 * DIRTY = creds edited but not yet re-Tested (the voice/Play block stays hidden). */
internal enum class SttsConn { NOT_SET_UP, DIRTY, TESTING, CONNECTED, NO_VOICES, FAILED }

internal suspend fun resolveConn(repo: ChatRepository): Pair<SttsConn, String> =
	foldConn(repo.sttsProbe(), repo.sttsReady())

// The gateway's displayLabel/sessionLabel wire schema caps both at 64 characters; enforced
// client-side too so pasting a long string reads as "can't type more" rather than a confusing
// server-side rejection once submitted.
internal const val SESSION_LABEL_MAX_CHARS = 64

internal const val WORKDIR_MAX_CHARS = 512
