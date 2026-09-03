package com.atelier_nyaarium.switchboard

import android.content.Context
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.atelier_nyaarium.switchboard.board.BoardDrop
import com.atelier_nyaarium.switchboard.board.BoardGroup
import com.atelier_nyaarium.switchboard.board.BoardLiveLine
import com.atelier_nyaarium.switchboard.board.BoardRow
import com.atelier_nyaarium.switchboard.plugins.Plugins
import kotlinx.coroutines.launch

////////////////////////////////
//  Functions & Helpers

/** Mint content:// Uris over a draft's already-copied files - the one remaining FileProvider mint
 * site, feeding them back through the ordinary Uri-based send/schedule API exactly like a fresh
 * pick. Restore never touches a Uri (MessageFile is the sole currency between the store and the
 * draft); only Send and Schedule Send need one, to reach send/scheduleSend. */
private fun draftFileUris(context: Context, files: List<MessageFile>): List<Uri> = files.mapNotNull { f ->
	Attachments.fileFor(context.filesDir, f.src)?.let { file ->
		FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
	}
}

////////////////////////////////
//  Composables

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadScreen(
	team: String,
	label: String,
	presence: String?,
	tabs: List<String>,
	tabLabel: (String) -> String,
	// Hold-to-drag reorder in the tab row (ReorderableTabRow); the committed order replaces
	// state.openTabs wholesale via ChatRepository.reorderTabs.
	onReorderTabs: (List<String>) -> Unit,
	messages: List<Message>,
	error: String?,
	rendererPool: ThreadRendererPool,
	canRename: Boolean,
	// Bumped by the caller on every genuine open gesture (see MainActivity's own doc on the
	// App-scope openNonce); keys ThreadWebView's reveal effect so it re-snaps to the first unread
	// row even when `team` itself is unchanged (re-tapping a notification for the open thread).
	openNonce: Int,
	// This session's board strip content: the tree rows when expanded, the live line collapsed.
	// Null hides the strip entirely (plugin off, or no board entries for this session).
	boardStrip: BoardGroup? = null,
	boardLiveLine: BoardLiveLine? = null,
	/** The board's own revision, which abandons a drag when a write lands mid-gesture. */
	boardRevision: Long = 0L,
	boardStripHeight: Int = AppStateStore.BOARD_STRIP_DEFAULT_DP,
	onBoardStripHeight: (Int) -> Unit = {},
	onOpenBoardEntry: (BoardRow) -> Unit = {},
	onMoveBoardEntry: (BoardRow, BoardDrop) -> Unit = { _, _ -> },
	// (team, at) a queue tile asked to land on, or null. Passed straight through to ThreadWebView.
	revealAt: Pair<String, Long>?,
	// Cleared once the reveal has been handed to the renderer. Without it the request stays set and
	// re-fires on every later genuine open of that thread, so a notification tap weeks later would
	// still snap to whichever message was once tapped in the queue.
	onRevealed: () -> Unit,
	// The current (first unread row id, pointer-region ids) for the team named by the argument,
	// re-read live at reveal time (never a stale snapshot) so a just-flushed receipt is always
	// reflected. Takes the team explicitly rather than closing over an ambient "current" team, so a
	// caller whose own team resolves after an async round-trip can never credit the wrong thread.
	unreadBoundary: (String) -> Pair<Long?, List<Long>>,
	onGateway: (String) -> Unit,
	onCloseTab: (String) -> Unit,
	onSessions: () -> Unit,
	// The four assembled subjects (see ThreadScreenState.kt): distinct types are what make handing
	// one cluster's fact to another's slot a compile error instead of a plausible call.
	composer: ComposerState,
	scheduled: ScheduledSendState,
	goal: GoalState,
	terminal: TerminalState,
	onRename: (String) -> Unit,
	onForget: () -> Unit,
	// The board gate, same as the sessions list: unfinished tasks turn Forget into a decision the
	// owner has to make. 0 (the default, and what an inactive board plugin reports) skips it, so the
	// two surfaces cannot disagree about when a forget is safe.
	undoneTasks: Int = 0,
	onForgetWithTasks: (Boolean) -> Unit = {},
	onFocusChange: (FocusIntent) -> Unit = {},
) {
	var showMenu by remember { mutableStateOf(false) }
	var showRename by remember { mutableStateOf(false) }
	var confirmForget by remember { mutableStateOf(false) }
	var showSendMenu by remember { mutableStateOf(false) }
	// The one remaining FileProvider mint site (see draftFileUris): Send and Schedule Send mint a
	// content:// Uri over the draft's already-copied files to reach the existing Uri-based send API.
	// Restore never touches a Uri - draft IS the restore, MessageFile the only currency, read
	// straight off ChatState.
	val composerContext = LocalContext.current
	// Null: no dialog. Non-null: the seed instant it opens the picker at - a fresh Schedule Send
	// seeds 5 minutes out, a dock edit seeds the record's own current fire time. Two distinct
	// booleans would let a stray recomposition show the dialog with a stale seed from the other path.
	// rememberSaveable: no android:configChanges is declared anywhere in this app, so a rotation,
	// theme, or font-scale change destroys and recreates the Activity - a plain remember here
	// silently closed an in-progress Schedule Send dialog on that recreation (the seed is just a
	// Long, trivially saveable, and the dialog's own dateState/timeState already survive via their
	// own internal Saver - only this flag was the gap).
	var scheduleDialogSeed by rememberSaveable { mutableStateOf<Long?>(null) }
	// Disables the Schedule button once tapped until the async call resolves - otherwise a double
	// tap (or a bounced/ghost touch, a documented real touchscreen artifact) can launch two
	// concurrent scheduleSend coroutines that race on which one's draft they see, since the FIRST
	// tap's own cleanup already clears it before the second tap's handler reads it.
	var scheduleSubmitting by remember { mutableStateOf(false) }
	val scheduleScope = rememberCoroutineScope()
	// ThreadScreen-scoped rather than scoped to the limit dock itself: the dock leaves composition as
	// soon as the block clears, and a scope dying mid-sequence would strand a partial injection (the
	// dialog answered, but "resume" never typed).
	var resumingAfterLimit by remember(team) { mutableStateOf(false) }
	val resumeScope = rememberCoroutineScope()
	// Bumped every time a NEW Schedule Send dialog session opens (a fresh schedule via the menu, or a
	// dock edit) - never on a bare dismiss. scheduleSubmitting/scheduleScope are ThreadScreen-scoped,
	// so a launched onConfirm continuation OUTLIVES the dialog: if the user dismisses while it is
	// still in flight and then reopens a NEW session before it resolves, the stale continuation must
	// recognize a newer session has taken over and skip its close-dialog/clear-composer side effects
	// - otherwise it closes whatever dialog is now open and can wipe a second attempt's freshly-typed
	// draft, exactly the generation-token shape Phase 1's DurableOpStore uses for the identical "a
	// stale attempt must not act after a newer one has taken over" problem.
	var scheduleDialogGeneration by remember { mutableStateOf(0) }
	// The Goal dialog's own three, for the same reasons as the Schedule Send trio above.
	var goalDialogOpen by rememberSaveable { mutableStateOf(false) }
	var goalSubmitting by remember { mutableStateOf(false) }
	var goalDialogGeneration by remember { mutableStateOf(0) }
	val goalScope = rememberCoroutineScope()
	// The raw-tmux terminal view, toggled from the top bar; re-keyed when switching session. A plain
	// still-waking session (asleep, booting, or a fresh create) opens to CHAT by default - only a
	// session already known to be stuck (terminal.needsLogin) jumps straight to terminal, so the
	// human sees the problem instantly instead of watching an otherwise-uneventful boot.
	var terminalMode by remember(team) {
		val booting = terminal.presence?.isOnline != true
		mutableStateOf(terminal.eligible && booting && terminal.needsLogin)
	}
	if (terminalMode) BackHandler { terminalMode = false }
	// The chat half shows daemon-derived state too (the presence chip), and closing the terminal
	// declares background on the way out. Without this the chip sits at the background cadence until
	// the user navigates all the way back to the session list.
	LaunchedEffect(terminalMode) {
		if (!terminalMode) onFocusChange(FocusIntent(screen = "board"))
	}
	val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
		if (uris.isNotEmpty()) composer.onAddFiles(uris)
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
	if (confirmForget && undoneTasks > 0) {
		BoardForgetDialog(
			label = label,
			undone = undoneTasks,
			onCancelTasks = {
				confirmForget = false
				onForgetWithTasks(true)
			},
			onUnassign = {
				confirmForget = false
				onForgetWithTasks(false)
			},
			onDismiss = { confirmForget = false },
		)
	} else if (confirmForget) {
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
	scheduleDialogSeed?.let { seed ->
		ScheduleSendDialog(
			initialAtMillis = seed,
			submitting = scheduleSubmitting,
			onConfirm = { at ->
				// Snapshot now: the async call below must bank exactly what was on screen at the
				// moment of the tap, not whatever the draft happens to hold once it resolves.
				val text = composer.draft.text
				val files = draftFileUris(composerContext, composer.draft.files)
				val editingExisting = scheduled.record != null
				val myGeneration = scheduleDialogGeneration
				scheduleSubmitting = true
				scheduleScope.launch {
					var ok = false
					try {
						// The picker's own isFarEnoughOut gate is evaluated once per recomposition and
						// never re-checked against a live clock while the user idles on the dialog - the
						// repo-side call below is the authoritative, freshly-evaluated check, and it can
						// fail (a stale pick, or - unlikely but real - a device clock jump). Only clear the
						// composer once that call reports genuine success, never optimistically on tap:
						// clearing first and finding out later would destroy the user's message on any
						// failure, with no way to recover it.
						ok = if (editingExisting) scheduled.onReschedule(at) else scheduled.onSchedule(text, files, at)
					} finally {
						// try/finally, not a bare sequential call: makes the re-enable explicit rather than
						// incidental on today's callees happening not to throw (both already runCatching
						// their own IO internally) - a future edit that lets either genuinely throw must
						// not leave the Schedule button stuck disabled forever.
						//
						// This continuation can outlive the dialog (scheduleSubmitting/scheduleScope are
						// ThreadScreen-scoped, not dialog-scoped): if the user dismissed while this was in
						// flight and reopened a NEW session before it resolved, scheduleDialogGeneration
						// has since moved on - committing this stale attempt's side effects would close
						// the freshly-reopened dialog and, on success, wipe whatever the second attempt
						// had already typed. A bare dismiss with no reopen does not bump the generation,
						// so a late success still clears the composer in that (milder, non-destructive)
						// case.
						if (scheduleDialogGeneration == myGeneration) {
							scheduleSubmitting = false
							scheduleDialogSeed = null
							if (ok && !editingExisting) composer.onClear()
						}
					}
				}
			},
			onDismiss = { scheduleDialogSeed = null },
		)
	}
	if (goalDialogOpen) {
		GoalDialog(
			submitting = goalSubmitting,
			onConfirm = { typed ->
				// Snapshot at the tap, not whatever the draft holds once the call resolves.
				val text = composer.draft.text
				val files = draftFileUris(composerContext, composer.draft.files)
				val myGeneration = goalDialogGeneration
				goalSubmitting = true
				goalScope.launch {
					var ok = false
					try {
						ok = goal.onArm(typed, text, files)
					} finally {
						// Cleared only on a genuine arm: a failure means nothing went out.
						if (goalDialogGeneration == myGeneration) {
							goalSubmitting = false
							goalDialogOpen = false
							if (ok) composer.onClear()
						}
					}
				}
			},
			onDismiss = { goalDialogOpen = false },
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
					if (terminal.eligible) {
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
				ReorderableTabRow(tabs = tabs, selected = team, tabLabel = tabLabel, onSelect = onGateway, onReorder = onReorderTabs)
			}
			// Below the tab row, not above it. The strip is the open tab's own entries and its height
			// changes as they do, which walked the tab row up and down the screen under it.
			if (boardStrip != null && !terminalMode) {
				com.atelier_nyaarium.switchboard.board.BoardStrip(
					group = boardStrip,
					liveLine = boardLiveLine,
					revision = boardRevision,
					heightDp = boardStripHeight,
					onHeightDp = onBoardStripHeight,
					onOpenEntry = onOpenBoardEntry,
					onMove = onMoveBoardEntry,
				)
			}
			if (terminalMode) {
				TerminalView(
					team = team,
					refreshMs = terminal.refreshMs,
					presence = terminal.presence,
					onWake = terminal.onWake,
					onRelaunch = terminal.onRelaunch,
					onPeek = terminal.onPeek,
					onSend = terminal.onSend,
					onResumeAfterLimit = terminal.onResumeAfterLimit,
					onFocusChange = onFocusChange,
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
					openNonce = openNonce,
					unreadBoundary = unreadBoundary,
					revealAt = revealAt,
					onRevealed = onRevealed,
					composerOccupied = composer.draft.isOccupied,
					modifier = Modifier.weight(1f).fillMaxWidth(),
				)
			}
			// Above the plugin slots deliberately: nothing sent to a limit-blocked session is read until
			// the dialog clears, so this outranks anything else docked here.
			if (terminal.limitBlocked) {
				SessionLimitDock(
					detail = terminal.limitDetail,
					onResume = {
						resumingAfterLimit = true
						resumeScope.launch {
							runCatchingCancellable { terminal.onResumeAfterLimit() }
							resumingAfterLimit = false
						}
					},
					resumeEnabled = !resumingAfterLimit,
				)
			}
			// Plugin dock slots (e.g. the Designer dock) sit between the messages and the
			// composer; each slot draws nothing when it has nothing to show for this thread. The
			// scope carries a composer-insert seam (e.g. the Designer's "Reference in chat"), team-bound
			// through composer.onAppendText -> ChatRepository.appendDraftText rather than an ambient var.
			val dockScope = com.atelier_nyaarium.switchboard.plugins.ThreadDockScope(team, composer.onAppendText)
			// Composable slots cannot route through forEachCaught (a @Composable invocation needs the
			// enclosing composable context, which a non-inline lambda parameter does not provide);
			// a throwing slot is Compose's own error path, not a registry-containment case.
			remember { Plugins.get(composerContext) }.host.threadDockSlots.values().forEach { slot -> slot(dockScope) }
			// A tapped ref opens full-screen over this thread. The request carries its own team, so a
			// tap that lands after a tab switch never opens in the wrong conversation.
			var openReference by remember(team) {
				mutableStateOf<com.atelier_nyaarium.switchboard.plugins.references.ReferenceOpenRequest?>(null)
			}
			LaunchedEffect(team) {
				com.atelier_nyaarium.switchboard.plugins.references.ReferenceOpenBus.events.collect { request ->
					if (request.team == team) openReference = request
				}
			}
			openReference?.let { request ->
				Dialog(
					onDismissRequest = { openReference = null },
					properties = DialogProperties(usePlatformDefaultWidth = false),
				) {
					Surface(modifier = Modifier.fillMaxSize()) {
						com.atelier_nyaarium.switchboard.plugins.references.ReferenceViewer(request)
					}
				}
			}
			if (composer.sendAwaitingWake) WakingNotice(label)
			// A plain sibling in this same Column, same reason the plugin dock slots above need no
			// collision-avoidance logic: nothing to show contributes no space at all.
			scheduled.record?.let { rec ->
				ScheduledSendDock(
					rec = rec,
					onEdit = {
						scheduleDialogSeed = rec.fireAtMillis
						scheduleDialogGeneration++
					},
					cancelEnabled = !composer.draft.isOccupied,
					onCancel = scheduled.onCancel,
				)
			}
			goal.record?.let { rec -> GoalDock(rec = rec, onCancel = goal.onCancel) }
			if (error != null) Text(error, Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.error)
			// Hidden entirely while something is scheduled - the dock above is the sole surface then;
			// letting the text field survive alongside it would let the user keep typing into a
			// message that no longer has anywhere to go until the dock is cancelled or fires.
			if (scheduled.record == null) {
			DraftAttachments(
				files = composer.draft.files,
				filesDir = composerContext.filesDir,
				onOpen = composer.onOpenFile,
				onRemove = composer.onRemoveFile,
			)
			// Composer-local, like DraftStrip's own expand: this describes the VIEW, not the draft, so
			// it must not follow a tab switch or survive into what gets sent.
			var composerCollapsed by remember { mutableStateOf(false) }
			// A long draft grows the field until it covers the conversation it is a reply to. Pinning it
			// to two lines gives the thread back without touching what has been typed.
			Row(
				Modifier.fillMaxWidth().padding(horizontal = 8.dp),
				horizontalArrangement = Arrangement.End,
			) {
				IconButton(onClick = hapticClick { composerCollapsed = !composerCollapsed }) {
					// Same direction as the board's own collapsers: open points down, shut points up.
					Icon(
						if (composerCollapsed) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
						contentDescription = if (composerCollapsed) "Grow the message box" else "Shrink the message box",
					)
				}
			}
			Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
				OutlinedTextField(
					value = composer.draft.text,
					onValueChange = composer.onTextChange,
					label = { Text("Message") },
					minLines = 2,
					// Collapsed pins it at its minimum and scrolls inside; otherwise it grows freely.
					maxLines = if (composerCollapsed) 2 else Int.MAX_VALUE,
					modifier = Modifier.weight(1f),
				)
				// Attach stacks above Send in a narrow right column, so the text field
				// takes the remaining width.
				Column(
					Modifier.padding(start = 8.dp),
					horizontalAlignment = Alignment.End,
					// 40 + 5 + 40 spans the two-line field exactly, so the pair aligns to its edges.
					verticalArrangement = Arrangement.spacedBy(5.dp),
				) {
					// Tonal rather than filled so Send stays the dominant action in this column.
					FilledTonalIconButton(
						onClick = hapticClick { picker.launch(arrayOf("*/*")) },
						shape = RoundedCornerShape(8.dp),
						modifier = Modifier.size(width = 56.dp, height = 40.dp),
					) {
						Icon(Icons.Default.AttachFile, contentDescription = "Attach file")
					}
					val sendEnabled = composer.draft.isOccupied
					val sendHaptics = LocalHapticFeedback.current
					val sendStrongHaptic = rememberStrongHaptic()
					// Material3's IconButton family exposes no onLongClick, so Send is a hand-rolled Surface
					// with combinedClickable on the outer Box, which is what announces Role.Button.
					Box(
						modifier = Modifier
							.size(width = 56.dp, height = 40.dp)
							.clip(RoundedCornerShape(8.dp))
							.combinedClickable(
								enabled = sendEnabled,
								role = Role.Button,
								onLongClickLabel = "Schedule send",
								onClick = {
									sendHaptics.performHapticFeedback(HapticFeedbackType.LongPress)
									composer.onSend(composer.draft.text, draftFileUris(composerContext, composer.draft.files))
									composer.onClear()
								},
								onLongClick = {
									sendStrongHaptic()
									showSendMenu = true
								},
							),
						contentAlignment = Alignment.Center,
					) {
						Surface(
							modifier = Modifier.fillMaxSize(),
							shape = RoundedCornerShape(8.dp),
							color = if (sendEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f),
							contentColor = if (sendEnabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f),
						) {
							Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
								Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
							}
						}
					}
					DropdownMenu(expanded = showSendMenu, onDismissRequest = { showSendMenu = false }) {
						DropdownMenuItem(
							text = { Text("Schedule Send") },
							// No scheduled.record == null guard needed here: this whole menu is unreachable once
							// one's already active, since the composer row it lives in is replaced by the dock
							// entirely - the dock is the sole edit/reschedule/cancel surface.
							enabled = sendEnabled,
							onClick = hapticClick {
								showSendMenu = false
								scheduleDialogSeed = System.currentTimeMillis() + 5 * 60_000L
								scheduleDialogGeneration++
							},
						)
						// Absent, not disabled, without a drivable pane: the typing half could never happen.
						if (terminal.eligible) {
							DropdownMenuItem(
								text = { Text("Goal") },
								enabled = sendEnabled,
								onClick = hapticClick {
									showSendMenu = false
									goalDialogGeneration++
									goalDialogOpen = true
								},
							)
						}
						DropdownMenuItem(
							text = { Text("Send") },
							enabled = sendEnabled,
							onClick = hapticClick {
								showSendMenu = false
								composer.onSend(composer.draft.text, draftFileUris(composerContext, composer.draft.files))
								composer.onClear()
							},
						)
					}
				}
			}
			}
			}
		}
	}
}
