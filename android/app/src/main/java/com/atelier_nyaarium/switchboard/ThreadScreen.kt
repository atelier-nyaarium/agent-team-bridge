package com.atelier_nyaarium.switchboard

import android.content.Context
import android.net.Uri
import android.view.ViewGroup
import android.widget.FrameLayout
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
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.atelier_nyaarium.switchboard.board.BoardGroup
import com.atelier_nyaarium.switchboard.board.BoardLiveLine
import com.atelier_nyaarium.switchboard.plugins.Plugins
import com.atelier_nyaarium.switchboard.proto.FocusIntent
import kotlinx.coroutines.launch

////////////////////////////////
//  Functions & Helpers

/** Mint content:// Uris over a draft's already-copied files - the one remaining FileProvider mint
 * site, feeding them back through the ordinary Uri-based send/schedule API exactly like a fresh
 * pick. Restore never touches a Uri (MessageFile is the sole currency between the store and the
 * draft); only Send and Schedule Send need one, to reach ChatRepository.send/scheduleSend. */
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
	onSend: (String, List<Uri>) -> Unit,
	// This thread's composer state - what it shows and what Send consumes (ChatRepository.Draft).
	// The single source read by the text field, the attachment chips, and every occupied/enabled
	// check below; there is no local composable copy of it (see the deleted `draft`/`attachments`
	// vars this replaced), so a tab switch can never bleed one thread's picked files into another's.
	draft: Draft,
	onDraftTextChange: (String) -> Unit,
	onAddDraftFiles: (List<Uri>) -> Unit,
	onRemoveDraftFile: (String) -> Unit,
	onOpenDraftFile: (MessageFile) -> Unit,
	// The plugin dock's composer-insert seam (e.g. the Designer's "Reference in chat").
	onAppendDraftText: (String) -> Unit,
	// Send hands the draft's content off (re-bucketed under its own out-$opId - see the Send
	// handler below); this drops the draft and reclaims its now-unreferenced attachment copies.
	onClearDraft: () -> Unit,
	onRename: (String) -> Unit,
	onForget: () -> Unit,
	// The board gate, same as the sessions list: unfinished tasks turn Forget into a decision the
	// owner has to make. 0 (the default, and what an inactive board plugin reports) skips it, so the
	// two surfaces cannot disagree about when a forget is safe.
	undoneTasks: Int = 0,
	onForgetWithTasks: (Boolean) -> Unit = {},
	// At most one pending scheduled send for this team, null otherwise -
	// drives the dock and gates the long-press menu's Schedule Send item.
	scheduledSend: ScheduledSend?,
	// True while a send is waiting on this team's cold boot, drawing the notice card above the
	// composer (ChatState.wakingTeams).
	waking: Boolean,
	// suspend + Boolean (not fire-and-forget Unit): the repo-side time check is authoritative and can
	// fail (the picker's own gate goes stale if the user idles past its 1-minute floor) - the caller
	// must await the real outcome before clearing the composer, since clearing eagerly would destroy
	// the user's message on any failure with no way to recover it.
	onScheduleSend: suspend (String, List<Uri>, Long) -> Boolean,
	// Dock tap-to-edit is deliberately time-only, not a full text/attachment re-edit: the banked
	// attachments are already-copied MessageFile refs, not the live content:// Uris onScheduleSend
	// takes, so re-threading them through the same call without risking a silent attachment drop
	// would need its own dedicated seam. Changing the time alone has no such mismatch.
	onReschedule: suspend (Long) -> Boolean,
	// Cancels team's scheduled send and hands its content back into the draft itself (see
	// ChatRepository.cancelScheduledSendForEdit) - the dock reads the result through `draft`,
	// same as every other composer writer, rather than through a returned record.
	onCancelScheduledSend: () -> Unit,
	// Terminal view: only the host-agent and devcontainers are eligible. The peek/send are
	// team-bound suspend closures (the screen supplies the team).
	terminalEligible: Boolean,
	sessionStatus: String?,
	wakePending: Boolean,
	// Daemon-derived (presence plane), true independent of sessionStatus - a peeked pane can show a
	// login prompt while still "verifying", before the MCP handshake ever confirms it "online". The
	// one signal available at tap time that distinguishes a stuck boot from a plain one still in
	// progress (see the terminalMode default below).
	sessionNeedsLogin: Boolean,
	sessionLimitBlocked: Boolean,
	sessionLimitDetail: String?,
	onWake: () -> Unit,
	// The terminal palette's Wake up button: force-relaunch claude in a still-existing pane
	// (close_session + create_session composed - see ChatRepository.relaunchSession).
	onRelaunch: suspend () -> Unit,
	terminalRefreshMs: Long,
	onTerminalPeek: suspend (sinceHash: String?) -> Result<com.atelier_nyaarium.switchboard.proto.ConsolePeekResult>,
	onTerminalSend: suspend (text: String?, key: String?, submit: Boolean) -> Unit,
	// Clear a usage-limit dialog and pick the work back up (see ChatRepository.resumeAfterLimit).
	onResumeAfterLimit: suspend () -> Unit,
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
	// The raw-tmux terminal view, toggled from the top bar; re-keyed when switching session. A plain
	// still-waking session (asleep, booting, or a fresh create) opens to CHAT by default - only a
	// session already known to be stuck (sessionNeedsLogin) jumps straight to terminal, so the human
	// sees the problem instantly instead of watching an otherwise-uneventful boot.
	var terminalMode by remember(team) {
		val waking = sessionStatus in setOf(null, "available", "verifying")
		mutableStateOf(terminalEligible && waking && sessionNeedsLogin)
	}
	if (terminalMode) BackHandler { terminalMode = false }
	val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
		if (uris.isNotEmpty()) onAddDraftFiles(uris)
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
				val text = draft.text
				val files = draftFileUris(composerContext, draft.files)
				val editingExisting = scheduledSend != null
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
						ok = if (editingExisting) onReschedule(at) else onScheduleSend(text, files, at)
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
							if (ok && !editingExisting) onClearDraft()
						}
					}
				}
			},
			onDismiss = { scheduleDialogSeed = null },
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
				ReorderableTabRow(tabs = tabs, selected = team, tabLabel = tabLabel, onSelect = onGateway, onReorder = onReorderTabs)
			}
			// Below the tab row, not above it. The strip is the open tab's own entries and its height
			// changes as they do, which walked the tab row up and down the screen under it.
			if (boardStrip != null && !terminalMode) {
				com.atelier_nyaarium.switchboard.board.BoardStrip(group = boardStrip, liveLine = boardLiveLine)
			}
			if (terminalMode) {
				TerminalView(
					team = team,
					refreshMs = terminalRefreshMs,
					wakePending = wakePending,
					sessionStatus = sessionStatus,
					onWake = onWake,
					onRelaunch = onRelaunch,
					onPeek = onTerminalPeek,
					onSend = onTerminalSend,
					onResumeAfterLimit = onResumeAfterLimit,
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
					composerOccupied = draft.isOccupied,
					modifier = Modifier.weight(1f).fillMaxWidth(),
				)
			}
			// Above the plugin slots deliberately: nothing sent to a limit-blocked session is read until
			// the dialog clears, so this outranks anything else docked here.
			if (sessionLimitBlocked) {
				SessionLimitDock(
					detail = sessionLimitDetail,
					onResume = {
						resumingAfterLimit = true
						resumeScope.launch {
							runCatching { onResumeAfterLimit() }
							resumingAfterLimit = false
						}
					},
					resumeEnabled = !resumingAfterLimit,
				)
			}
			// Plugin dock slots (e.g. the Designer dock) sit between the messages and the
			// composer; each slot draws nothing when it has nothing to show for this thread. The
			// scope carries a composer-insert seam (e.g. the Designer's "Reference in chat"), team-bound
			// through onAppendDraftText -> ChatRepository.appendDraftText rather than an ambient var.
			val dockScope = com.atelier_nyaarium.switchboard.plugins.ThreadDockScope(team, onAppendDraftText)
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
			if (waking) WakingNotice(label)
			// A plain sibling in this same Column, same reason the plugin dock slots above need no
			// collision-avoidance logic: nothing to show contributes no space at all.
			scheduledSend?.let { rec ->
				ScheduledSendDock(
					rec = rec,
					onEdit = {
						scheduleDialogSeed = rec.fireAtMillis
						scheduleDialogGeneration++
					},
					cancelEnabled = !draft.isOccupied,
					onCancel = onCancelScheduledSend,
				)
			}
			if (error != null) Text(error, Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.error)
			// Hidden entirely while something is scheduled - the dock above is the sole surface then;
			// letting the text field survive alongside it would let the user keep typing into a
			// message that no longer has anywhere to go until the dock is cancelled or fires.
			if (scheduledSend == null) {
			DraftAttachments(
				files = draft.files,
				filesDir = composerContext.filesDir,
				onOpen = onOpenDraftFile,
				onRemove = onRemoveDraftFile,
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
					value = draft.text,
					onValueChange = onDraftTextChange,
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
					val sendEnabled = draft.isOccupied
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
									onSend(draft.text, draftFileUris(composerContext, draft.files))
									onClearDraft()
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
							// No scheduledSend == null guard needed here: this whole menu is unreachable once
							// one's already active, since the composer row it lives in is replaced by the dock
							// entirely - the dock is the sole edit/reschedule/cancel surface.
							enabled = sendEnabled,
							onClick = hapticClick {
								showSendMenu = false
								scheduleDialogSeed = System.currentTimeMillis() + 5 * 60_000L
								scheduleDialogGeneration++
							},
						)
						DropdownMenuItem(
							text = { Text("Send") },
							enabled = sendEnabled,
							onClick = hapticClick {
								showSendMenu = false
								onSend(draft.text, draftFileUris(composerContext, draft.files))
								onClearDraft()
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

/**
 * The queue list, and everything it has to re-read to stay honest.
 *
 * Its OWN composable so the 500ms bar tick recomposes this sheet and nothing else. Held in App, the
 * beat sat in that scope and re-ran the whole activity's composition twice a second for as long as
 * the sheet was open.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun QueueSheetHost(repo: ChatRepository, onDismiss: () -> Unit, onJump: (QueueEntry) -> Unit) {
	// Re-read on every settled change, and on a slow tick so the bar moves while a message plays. Both
	// are pulls: this sheet is the fourth surface reporting one run, and the three that kept their own
	// copy are the three that drifted from it.
	val revision by repo.playback.queueRevision.collectAsState()
	var beat by remember { mutableStateOf(0) }
	LaunchedEffect(Unit) {
		while (true) {
			kotlinx.coroutines.delay(500)
			beat++
		}
	}
	val rows = remember(revision, beat) { repo.playback.queueRows() }
	val failed = remember(revision) { repo.playback.failedRows() }
	val position = remember(revision, beat) { repo.playback.playbackPosition() }
	val held = remember(revision) { repo.playback.heldPosition() }
	val paused = remember(revision) { repo.playback.transportState().second }
	androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
		QueueSheet(
			rows = rows,
			failed = failed,
			paused = paused,
			positionMs = position?.positionMs ?: held,
			durationMs = position?.durationMs,
			onPlayPause = { repo.command { if (paused) playback.resumePlayback() else playback.pausePlayback() } },
			onSkip = { repo.command { playback.skipPlayback() } },
			onSeek = { repo.playback.seekPlayback(it) },
			onTrash = { entry -> repo.command { playback.dropFromQueue(entry) } },
			onJump = onJump,
			onDismissFailure = { entry -> repo.command { playback.acknowledgeFailure(entry) } },
		)
	}
}

/**
 * Hosts a thread's pooled WebView inside a FrameLayout. The renderer is pulled from
 * the pool (so scroll position and rendered DOM survive tab switches and Sessions
 * round-trips) and re-fed incrementally via sync(). A crashed renderer is swapped
 * for a fresh one and re-fed.
 */
@Composable
fun ThreadWebView(
	team: String,
	messages: List<Message>,
	rendererPool: ThreadRendererPool,
	openNonce: Int,
	unreadBoundary: (String) -> Pair<Long?, List<Long>>,
	// (team, at) a queue tile asked to land on, or null for an ordinary open. Carries its team so a
	// stale request cannot scroll a thread it was never about.
	revealAt: Pair<String, Long>?,
	// Cleared once the reveal has been handed to the renderer. Without it the request stays set and
	// re-fires on every later genuine open of that thread, so a notification tap weeks later would
	// still snap to whichever message was once tapped in the queue.
	onRevealed: () -> Unit,
	// Whether the composer holds text: mirrored into the renderer so a failed row's Cancel, which
	// hands its content back to that box, greys out rather than overwriting what is being typed.
	composerOccupied: Boolean,
	modifier: Modifier,
) {
	var renderer by remember(team) { mutableStateOf(rendererPool.get(team)) }
	val filesDir = LocalContext.current.filesDir

	LaunchedEffect(renderer, composerOccupied) { renderer.setComposerOccupied(composerOccupied) }

	DisposableEffect(renderer) {
		renderer.onRendererGone = { renderer = rendererPool.recreate(team) }
		onDispose { renderer.onRendererGone = null }
	}
	// Ongoing delta-sync on every message-list change - unaffected by opens/reveals below, so an
	// already-open thread keeps rendering new arrivals live. `team` is this composable's own stable
	// parameter (never the ambient "currently on screen" team): the JS round-trip inside the reveal
	// effect below can resolve after the user has navigated elsewhere, so closing over anything
	// mutable here would credit or crash on the wrong thread.
	// Keyed on the frame generation as well as the list: a video's frames land after its row is on
	// screen and change nothing the list itself would notice, so without this no sync runs at all.
	// The matching half is in ThreadRenderer's fingerprint, which decides whether the row re-pushes.
	LaunchedEffect(renderer, messages, FrameReadiness.generation) {
		renderer.sync(messages, unreadBoundary(team).first)
	}
	// Frames are extracted lazily and cost several seeks each, so a row renders with its glyph and
	// gains motion later. Deliberately NOT keyed on the generation this marks, which would make each
	// landing set retrigger the whole pass.
	LaunchedEffect(renderer, messages) {
		for (message in messages) {
			for (file in message.files) {
				if (!file.mime.startsWith("video/")) continue
				val key = VideoThumbs.keyFor(file) ?: continue
				// Skip on ANNOUNCED, never on "already on disk". Extraction does not observe
				// cancellation, so an interrupted pass still writes its full set; keying the skip on
				// the files would then make every later pass step over it, leaving the row rendered as
				// a plain file forever with a complete set sitting unused. This also keeps the common
				// case off the disk entirely.
				if (FrameReadiness.versionOf(key) > 0) continue
				val source = Attachments.fileFor(filesDir, file.src) ?: continue
				if (VideoThumbs.ensure(filesDir, key, source).isNotEmpty()) FrameReadiness.mark(key)
			}
		}
	}
	// A genuine open (notification tap, board tap, tab switch onto a different thread, or
	// composition re-entry after a masked surface like terminal mode or settings) re-snaps to the
	// first unread row. Declared AFTER the sync effect so its own (idempotent) sync() call and
	// flush-then-reveal always run against an already-rendered transcript.
	LaunchedEffect(team, renderer, openNonce) {
		renderer.sync(messages, unreadBoundary(team).first)
		renderer.flushThenReveal {
			val (firstUnreadId, region) = unreadBoundary(team)
			renderer.revealFirstUnread(firstUnreadId, region)
			// A queue tile named a specific message, so land on THAT rather than wherever reading
			// happens to have got to. Runs after the unread snap so it wins, and only for the thread the
			// tile pointed at - a tile tapped while a different tab was open must not drag this one.
			//
			// Resolved to the ROW KEY here. A queue entry is identified by its timestamp, but the DOM is
			// keyed by Message.id, a per-thread local key that is deliberately not `at` - handing the
			// timestamp straight to the renderer matched no row at all, so the jump silently did nothing.
			revealAt?.let { (wanted, at) ->
				if (wanted == team) {
					messages.firstOrNull { it.at == at && !it.fromMe }?.let { renderer.revealMessage(it.id) }
					onRevealed()
				}
			}
		}
	}

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
