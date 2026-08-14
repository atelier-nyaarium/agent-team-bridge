package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.board.BoardScreen
import com.atelier_nyaarium.switchboard.board.BoardSource
import com.atelier_nyaarium.switchboard.board.GroupKey
import com.atelier_nyaarium.switchboard.board.flattenBoard
import com.atelier_nyaarium.switchboard.plugins.Plugins
import com.atelier_nyaarium.switchboard.proto.FocusIntent
import com.atelier_nyaarium.switchboard.proto.isComposite

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
	val revealAtState = remember { mutableStateOf<Pair<String, Long>?>(null) }
	var revealAt by revealAtState
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
	// Every screen above the base layer, newest last (see Overlay.kt). Not saveable: a ceremony
	// entry carries key material.
	var overlays by remember { mutableStateOf(emptyList<Overlay>()) }
	val openOverlay = { overlay: Overlay -> overlays = overlays.pushOverlay(overlay) }
	val closeOverlay = { overlays = overlays.popOverlay() }
	// One-shot so the enrollee compare auto-pops once after first-root, never re-popping after a
	// manual dismiss (the board keeps a "Verify with the admin" entry for that).
	var enrolleeCeremonyOffered by remember { mutableStateOf(false) }
	var unlocked by remember { mutableStateOf(false) }

	// The plugin framework boots with the app (not on first Settings open): an enabled plugin's
	// contributions must be live for every surface that consults a registry, not only after the
	// user happens to visit the toggle screen.
	val pluginManager = remember { Plugins.get(context) }

	val viewerState = remember { mutableStateOf<OpenAttachment?>(null) }
	var viewer by viewerState
	val linkMenuState = remember { mutableStateOf<Pair<String, String>?>(null) }
	val linkMenuNoteState = remember { mutableStateOf<String?>(null) }
	val rendererPool = rememberBoundRendererPool(repo, pluginManager, viewerState, linkMenuState, linkMenuNoteState)

	LaunchedEffect(injectedBlob) {
		if (injectedBlob != null && !state.provisioned) repo.provision(injectedBlob)
	}
	// Auto-pop the in-person enroll compare once the device first-roots an enroll invite (the admin is
	// right there, mid-scan). One-shot: a dismiss does not re-pop it; the empty board keeps a manual
	// "Verify with the admin" entry, and a completed compare latches it off.
	LaunchedEffect(state.provisioned, state.firstRooted) {
		if (state.provisioned && !enrolleeCeremonyOffered) {
			repo.ceremony.pendingEnrolleeCeremony()?.let {
				openOverlay(Overlay.EnrolleeCeremony(it))
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
			// A tapped notification surfaces its thread, so nothing may stay above it: clearing the
			// stack covers every overlay by construction, including ones added later.
			showSettings = false
			settingsRoute = SettingsRoute.HUB
			overlays = emptyList()
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
	// TerminalView's own terminal-focus declaration while a specific session's terminal is open; an
	// open thread declares its own, since its presence chip is daemon-derived as well.
	LaunchedEffect(openTeam) {
		if (openTeam == null) repo.declareFocus(FocusIntent(screen = "board"))
	}

	val locked = state.provisioned && state.biometricLock && !unlocked
	LaunchedEffect(locked) {
		if (locked && activity != null) promptUnlock(activity) { ok -> if (ok) unlocked = true }
	}

	// System back navigates within the app instead of exiting. The arms are in RENDER order (see the
	// `when` below), so back always dismisses what is actually on screen.
	BackHandler(enabled = overlays.isNotEmpty() || showSettings || openTeam != null) {
		when {
			overlays.isNotEmpty() -> closeOverlay()
			showSettings && settingsRoute != SettingsRoute.HUB -> settingsRoute = SettingsRoute.HUB
			showSettings -> showSettings = false
			else -> openTeam = null
		}
	}

	when {
		// Lock wins over everything (a provisioned + locked session must show the lock, never a
		// leftover overlay underneath it). An unprovisioned session is never locked.
		locked -> LockScreen(onUnlock = { activity?.let { a -> promptUnlock(a) { ok -> if (ok) unlocked = true } } })
		// One arm keyed on the stack top, so render order can never disagree with what is showing.
		overlays.isNotEmpty() -> OverlayHost(overlays.last(), repo, state, openOverlay, closeOverlay)
		// Settings is reachable from ANY state, so this branch is evaluated BEFORE the unprovisioned
		// ProvisionScreen below (the setup screen's gear opens it). Overlays are entered from Settings
		// without closing it, so they sit above.
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
				onManage = { openOverlay(Overlay.Manage) },
				onYourDevices = { openOverlay(Overlay.YourDevices) },
				// Users is the federation surface; the federation actions live in its top-bar menu.
				onFederation = { openOverlay(Overlay.Users) },
				onClear = {
					// The Domain-delete transaction (DomainAdminOps.deleteDomain) owns the local wipe; drop
					// plugin device state (e.g. the Designer index) alongside it, then navigate home.
					pluginManager.host.accountWipeHandlers.forEachCaught(onError = ::logPluginThrow) { it.onWipe(context) }
					showSettings = false
					settingsRoute = SettingsRoute.HUB
					overlays = emptyList()
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
			val boardRevision by repo.boardOps.boardRevision
			// boardGateway is a key here for the same reason the effect above takes it: it answers the
			// route Gateway until the roster lands, and a failed read never bumps the revision.
			val boardStripFor = remember(openTeam, boardRevision, boardOn, boardGateway) {
				if (!boardOn) null
				else {
					val key = GroupKey(boardGateway, repo.boardOps.boardSessionKeyOf(openTeam!!))
					flattenBoard(listOf(BoardSource(boardGateway, repo.boardOps.boardEntriesFor(openTeam))))
						.sessions.firstOrNull { it.key == key }
				}
			}
			val boardLiveLineFor = remember(openTeam, boardRevision, boardOn, boardGateway) {
				if (boardOn) repo.boardOps.boardLiveLineFor(openTeam!!) else null
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
				composer = ComposerState(
					draft = state.drafts[openTeam!!] ?: Draft(),
					sendAwaitingWake = openTeam!! in state.wakingTeams,
					onSend = { text, uris -> repo.command { send(openTeam!!, text, uris) } },
					onTextChange = { repo.setDraftText(openTeam!!, it) },
					onAddFiles = { uris -> repo.command { addDraftFiles(openTeam!!, uris) } },
					onRemoveFile = { src -> repo.removeDraftFile(openTeam!!, src) },
					// A draft file resolves the same way a tapped transcript attachment does, so the
					// viewer sees one shape of OpenAttachment no matter which surface opened it.
					onOpenFile = { file ->
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
					onAppendText = { insert -> repo.appendDraftText(openTeam!!, insert) },
					onClear = { repo.clearDraft(openTeam!!) },
				),
				scheduled = ScheduledSendState(
					record = state.scheduledSends[openTeam!!],
					onSchedule = { text, uris, at -> repo.scheduled.scheduleSend(openTeam!!, text, uris, at) },
					onReschedule = { at -> repo.scheduled.rescheduleSend(openTeam!!, at) },
					onCancel = { repo.scheduled.cancelScheduledSendForEdit(openTeam!!) },
				),
				goal = GoalState(
					record = state.goals[openTeam!!],
					onArm = { g, text, uris -> repo.goals.armAndSend(openTeam!!, g, text, uris) },
					onCancel = { repo.goals.cancelGoal(openTeam!!) },
				),
				onRename = { name -> repo.command { rename(openTeam!!, name) } },
				onForget = {
					val forgotten = openTeam!!
					repo.sessions.forget(forgotten)
					forgetTeardown(forgotten)
				},
				// The board gate: the same decision the sessions list asks for, so the two surfaces
				// cannot disagree about when a forget is safe.
				undoneTasks = if (boardOn) repo.boardOps.boardUndoneCountFor(openTeam!!) else 0,
				onForgetWithTasks = { cancelThem ->
					val forgotten = openTeam!!
					repo.boardOps.forgetWithBoardDisposition(forgotten, cancelThem) { forgetTeardown(forgotten) }
				},
				terminal = TerminalState(
					// A LOCAL composite session has a daemon-drivable pane; remote-Gateway is gated off
					// in v1, and the host machine's terminal is reached through the dedicated "host" target.
					eligible = isComposite(localFieldOf(openTeam!!)) &&
						(session?.gatewayId.isNullOrEmpty() || session.gatewayId == state.localGatewayId),
					sessionStatus = session?.status,
					// Daemon-derived (presence plane), so it can be true even before "online" - a peeked
					// pane stuck at a login prompt is knowable while the MCP handshake is still pending.
					needsLogin = session?.needsLogin == true,
					// Also daemon-derived, so the chat view learns about a block with no peek of its own.
					limitBlocked = session?.limitBlocked == true,
					limitDetail = session?.limitDetail,
					// A "verifying" session is coming up (a wake in flight, through the MCP handshake), so
					// the terminal seeds "Waking..." rather than "asleep".
					wakeInFlight = session?.status == "verifying",
					onWake = { repo.sessions.wakeSession(openTeam!!) },
					onRelaunch = { repo.sessions.relaunchSession(openTeam!!) },
					refreshMs = repo.sessions.terminalRefreshMs,
					onPeek = { hash -> repo.sessions.peekTerminal(openTeam!!, hash) },
					onSend = { text, key, submit -> repo.sessions.tmuxSend(openTeam!!, text, key, submit) },
					onResumeAfterLimit = { repo.sessions.resumeAfterLimit(openTeam!!) },
				),
				onFocusChange = repo::declareFocus,
			)
		}
		else -> {
			val snackbarHostState = remember { SnackbarHostState() }
			// One-shot: a create_session failure or abandonment surfaces here instead of the sticky
			// connection-health state.error, so it never bleeds into an unrelated later health render.
			LaunchedEffect(state.transientMessage) {
				state.transientMessage?.let {
					repo.sessions.consumeTransientMessage()
					snackbarHostState.showSnackbar(it)
				}
			}
			// Folded ONCE per board revision, not per card per recomposition: each call replays the
			// whole pending queue over the whole snapshot, and the session list recomposes on every
			// poll (unread, snippet, presence).
			val boardOnHere = pluginManager.isActive("taskboard")
			val boardRevisionForCards by repo.boardOps.boardRevision
			val boardLines = remember(boardRevisionForCards, state.teams, boardOnHere) {
				if (!boardOnHere) emptyMap()
				else state.teams.associate { it.name to repo.boardOps.boardLiveLineFor(it.name) }
			}
			// Alongside the lines rather than inside the card, on the same revision key: the list
			// recomposes on every poll and a per-card flatten would rebuild every session's tree each time.
			val boardBranches = remember(boardRevisionForCards, state.teams, boardOnHere) {
				if (!boardOnHere) emptyMap()
				else state.teams.mapNotNull { team ->
					val line = boardLines[team.name] ?: return@mapNotNull null
					team.name to repo.boardOps.boardCardBranchFor(team.name, line.currentId)
				}.toMap()
			}
			MainTabsScreen(
				state = state,
				boardEnabled = pluginManager.isActive("taskboard"),
				snackbarHostState = snackbarHostState,
				onRefresh = {
					repo.command { presence.refreshTeams() }
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
						onOpenEntry = { gw, id -> openOverlay(Overlay.BoardEdit(gw, id)) },
						onSaved = goToSessions,
						modifier = modifier,
					)
				},
				sessions = { modifier ->
					SessionsScreen(
						state = state,
						modifier = modifier,
						onRefresh = { repo.command { presence.refreshTeams() } },
						onManage = { openOverlay(Overlay.Manage) },
						onAddGateway = { openOverlay(Overlay.AddGateway) },
						onHostHelp = { openOverlay(Overlay.HostHelp) },
						onOpen = { team ->
							openTeam = repo.openThread(team)
							openNonce++
						},
						onRename = { team, name -> repo.command { rename(team, name) } },
						onForget = { team ->
							pluginManager.host.threadForgetHandlers.forEachCaught(onError = ::logPluginThrow) {
								it.onForget(context, team)
							}
							repo.sessions.forget(team)
							SwitchboardService.cancelTeamNotification(context, team)
							SwitchboardService.cancelScheduledSendFailedNotification(context, team)
						},
						// Fire the create and stay on the board: the gateway adopts the session's record
						// synchronously and bumps the presence plane with it, so its own tile appears via
						// this device's own next poll (spinner while it boots) with no separate refresh.
						// Tapping the tile opens its terminal view. A failure surfaces as a Snackbar.
						onSpawn = { project, label, workdir -> repo.command { sessions.spawnSession(project, label, workdir) } },
						onListDirs = { path -> repo.sessions.listDirs(path) },
						// Launch the enrollee compare from the empty board when one is still owed (the
						// device rooted an enroll invite but has not completed the in-person trust step).
						onVerifyEnroll = (if (state.provisioned) repo.ceremony.pendingEnrolleeCeremony() else null)
							?.let { c -> { openOverlay(Overlay.EnrolleeCeremony(c)) } },
						boardLine = { team -> boardLines[team.name] },
						boardBranch = { team -> boardBranches[team.name] },
						undoneFor = { team ->
							if (pluginManager.isActive("taskboard")) {
								repo.boardOps.boardUndoneCountFor(team.name)
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

	QueueOverlay(repo, openQueueRequest, locked, revealAtState, openTeamRequest)
	AttachmentViewerOverlay(viewerState, rendererPool)
	LinkMenuDialog(linkMenuState, linkMenuNoteState)
}

/** Registry onError sink shared by every plugin-registry consultation site: a claim that threw
 * is logged and skipped, never fatal. */
internal fun logPluginThrow(message: String, err: Throwable) {
	DebugLog.log("Plugins", "$message: $err")
}
