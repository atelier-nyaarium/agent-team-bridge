package com.atelier_nyaarium.switchboard.board

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.proto.BoardEntry

////////////////////////////////
//  The Task Board tab

/** Which sheet is open: a long-pressed entry's action sheet, or its assign picker. */
private sealed class BoardSheet {
	data class Actions(val row: BoardRow) : BoardSheet()
	data class Assign(val row: BoardRow) : BoardSheet()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoardScreen(
	state: ChatState,
	repo: ChatRepository,
	onOpenEntry: (String, String) -> Unit,
	// Where a saved entry leaves the owner. Saving is the end of a thought, and the session list is
	// where they act on it, so the board tab is the one place they do NOT want to land.
	onSaved: () -> Unit = {},
	modifier: Modifier = Modifier,
) {
	// Opening the tab refreshes every non-route Gateway's column (the route one rides the plane).
	LaunchedEffect(Unit) { repo.boardOps.refreshBoard() }

	// The revision read is what re-derives rows when the cache, queue or a plane snapshot moves.
	val revision by repo.board.revision
	val rows = remember(revision, state.teams) {
		val sessionGateway = { sessionKey: String -> repo.boardOps.boardGatewayOfKey(sessionKey) }
		val sources = repo.board.sourceGatewayIds().map { gw -> BoardSource(gw, repo.board.mergedEntries(gw)) }
		flattenBoard(sources, sessionGateway)
	}

	// A Gateway whose column could not be refreshed says HOW stale it is: a silently old column is
	// otherwise indistinguishable from a current one.
	val staleColumns = remember(revision) {
		val route = repo.boardOps.boardGatewayOf(null)
		repo.board.sourceGatewayIds()
			.filter { it != route }
			.mapNotNull { gw -> repo.board.lastSyncedAt(gw).takeIf { it > 0 }?.let { gw to it } }
			.filter { System.currentTimeMillis() - it.second > STALE_AFTER_MS }
	}

	val truncatedColumns = remember(revision) { repo.board.truncatedGateways() }
	// Entries whose queued write keeps failing. A row that looks applied but has not reached the
	// Gateway in many attempts is worth saying out loud, even though it is still retrying.
	val struggling = remember(revision) { repo.board.strugglingEntries() }

	var sheet by remember { mutableStateOf<BoardSheet?>(null) }
	var trashOpen by rememberSaveable { mutableStateOf(false) }
	// The compose form REPLACES the list rather than floating over it, so the owner can leave for the
	// session list, copy something, and come back to it still filled in. All three are saveable
	// because a tab swipe disposes this page, and typed-but-unsaved text is the one thing here that
	// cannot be got back.
	var composing by rememberSaveable { mutableStateOf(false) }
	var draftTitle by rememberSaveable { mutableStateOf("") }
	var draftBody by rememberSaveable { mutableStateOf("") }

	if (composing) {
		BoardComposeForm(
			title = draftTitle,
			body = draftBody,
			onTitle = { draftTitle = it },
			onBody = { draftBody = it },
			onCancel = { composing = false },
			onSave = {
				repo.boardOps.boardCapture(draftTitle.trim(), draftBody.trim().takeIf { it.isNotEmpty() })
				draftTitle = ""
				draftBody = ""
				composing = false
				onSaved()
			},
			modifier = modifier,
		)
		return
	}

	LazyColumn(modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
		// Silence here reads as success, so each gets its own dismissable line. The two kinds are
		// OPPOSITE outcomes and must not share wording: a refusal never landed and can simply be redone,
		// while a drop landed and took the pictures with it for good.
		for ((index, refusal) in repo.board.refusals.withIndex()) {
			item(key = "refused:$index:${refusal.entryId ?: "none"}") {
				// Named rather than left as a floating banner: without the task, the owner has no way to
				// tell which entry lost a picture.
				val named = refusal.entryId?.let { id ->
					repo.board.sourceGatewayIds().firstNotNullOfOrNull { gw ->
						repo.board.mergedEntries(gw).firstOrNull { it.id == id }?.title
					}
				}
				Row(
					Modifier.fillMaxWidth().combinedClickable(onClick = { repo.board.dismissRefusal(refusal) }).padding(vertical = 6.dp),
					horizontalArrangement = Arrangement.spacedBy(8.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					Text(
						when (refusal.kind) {
							BoardNoticeKind.DROPPED ->
								"Gone for good on ${named ?: "an entry"}: ${refusal.reason}. Nothing still had the file. Tap to dismiss."
							BoardNoticeKind.REFUSED ->
								"A change did not stick${named?.let { " on $it" } ?: ""} (${refusal.reason}). Tap to dismiss."
						},
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.error,
						maxLines = 3,
						overflow = TextOverflow.Ellipsis,
					)
				}
			}
		}

		for ((gw, at) in staleColumns) {
			item(key = "stale:$gw") {
				Text(
					"$gw last read ${relativeAge(at)} ago",
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
				)
			}
		}

		for (gw in truncatedColumns) {
			item(key = "cut:$gw") {
				Text(
					"$gw sent only part of its board; older entries may be missing",
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
				)
			}
		}

		item(key = "sect:backlog") {
			// The button rides the Backlog header rather than a row of its own: a new entry lands on the
			// backlog, so this is where it belongs, and a lone button over empty space read as a mistake.
			BoardSectionLabel("Backlog") {
				// Says "Resume" when a draft is waiting: the button is the only trace of it once the form
				// is closed, and a bare "New" would read as discarding what is still there.
				Button(
					onClick = { composing = true },
					contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
					modifier = Modifier.height(34.dp),
				) {
					Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
					Spacer(Modifier.width(5.dp))
					Text(
						if (draftTitle.isBlank() && draftBody.isBlank()) "New" else "Resume draft",
						style = MaterialTheme.typography.labelLarge,
					)
				}
			}
		}
		boardGroupItems(
			this,
			rows.unassigned,
			onOpen = onOpenEntry,
			onLongPress = { sheet = BoardSheet.Actions(it) },
			struggling = struggling,
		)

		for (group in rows.sessions) {
			val gk = group.key ?: continue
			val sid = "${gk.gatewayId}/${gk.sessionId}"
			item(key = "sess:$sid") { SessionGroupHeader(state, gk) }
			boardGroupItems(
				this,
				group,
				onOpen = onOpenEntry,
				onLongPress = { sheet = BoardSheet.Actions(it) },
				struggling = struggling,
			)
		}

		if (rows.trash.isNotEmpty()) {
			item(key = "sect:trash") {
				BoardFoldRow(
					label = "Trash - ${rows.trash.size}",
					expanded = trashOpen,
					onToggle = { trashOpen = !trashOpen },
				)
			}
			if (trashOpen) {
				for (row in rows.trash) {
					item(key = row.entry.id) {
						BoardEntryRow(
							row,
							onClick = { onOpenEntry(row.gatewayId, row.entry.id) },
							onLongPress = { sheet = BoardSheet.Actions(row) },
						)
					}
				}
			}
		}
	}

	when (val open = sheet) {
		is BoardSheet.Actions -> {
			val entry = open.row.entry
			val gw = open.row.gatewayId
			ModalBottomSheet(onDismissRequest = { sheet = null }) {
				Column(Modifier.padding(bottom = 24.dp)) {
					if (entry.trashedAt != null) {
						SheetAction("Restore") {
							repo.boardOps.boardSetTrashed(gw, entry.id, false)
							sheet = null
						}
					} else {
						SheetAction("Assign to a session") { sheet = BoardSheet.Assign(open.row) }
						for (state2 in listOf("open", "in_progress", "paused", "done", "cancelled")) {
							if (state2 == entry.state) continue
							SheetAction("Mark ${stateLabel(state2)}") {
								repo.boardOps.boardSetState(gw, entry.id, state2)
								sheet = null
							}
						}
						if (entry.sessionId != null) {
							SheetAction("Back to the backlog") {
								repo.boardOps.boardAssign(gw, entry.id, null)
								sheet = null
							}
						}
						SheetAction("Trash") {
							repo.boardOps.boardSetTrashed(gw, entry.id, true)
							sheet = null
						}
					}
				}
			}
		}
		is BoardSheet.Assign -> {
			val entry = open.row.entry
			ModalBottomSheet(onDismissRequest = { sheet = null }) {
				Column(Modifier.padding(bottom = 24.dp)) {
					Text(
						"Assign to",
						style = MaterialTheme.typography.labelLarge,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
						modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
					)
					for (team in repo.boardOps.boardAssignTargets()) {
						SheetAction(state.label(team.name)) {
							repo.boardOps.boardAssign(open.row.gatewayId, entry.id, team.name)
							sheet = null
						}
					}
				}
			}
		}
		null -> {}
	}
}

////////////////////////////////
//  Rows

/** Emit one group's rows. Every LazyColumn key is an entry id (unique by flattenBoard's
 * construction) or a static section key. */
@OptIn(ExperimentalMaterial3Api::class)
private fun boardGroupItems(
	scope: androidx.compose.foundation.lazy.LazyListScope,
	group: BoardGroup,
	onOpen: (String, String) -> Unit,
	onLongPress: (BoardRow) -> Unit,
	struggling: Set<String>,
) {
	with(scope) {
		for (row in group.rows) {
			item(key = row.entry.id) {
				BoardEntryRow(
					row,
					onClick = { onOpen(row.gatewayId, row.entry.id) },
					onLongPress = { onLongPress(row) },
					struggling = row.entry.id in struggling,
				)
			}
		}
	}
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun BoardEntryRow(row: BoardRow, onClick: () -> Unit, onLongPress: () -> Unit, struggling: Boolean = false) {
	val entry = row.entry
	val finished = entry.state == "done" || entry.state == "cancelled"
	Row(
		Modifier
			.fillMaxWidth()
			.combinedClickable(onClick = onClick, onLongClick = onLongPress)
			.padding(start = (row.depth * 16).dp, top = 4.dp, bottom = 4.dp),
		horizontalArrangement = Arrangement.spacedBy(9.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		StateMark(entry.state)
		Text(
			entry.title,
			style = MaterialTheme.typography.bodyMedium,
			color = if (finished) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
			textDecoration = if (entry.state == "cancelled") TextDecoration.LineThrough else null,
			maxLines = 2,
			overflow = TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f),
		)
		if (!entry.attachments.isNullOrEmpty()) {
			Text(
				"📎",
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		if (struggling) {
			Text(
				"not synced",
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.error,
			)
		}
		entry.trashedAt?.let {
			Text(
				"${daysLeftInTrash(it)}d left",
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}

/** The task's own state, never the session's - session presence stays on the session card. Public
 * because the session card's live rung and the thread strip draw the same mark. */
@Composable
fun StateMark(state: String) {
	val color = when (state) {
		"in_progress" -> MaterialTheme.colorScheme.tertiary
		"done" -> MaterialTheme.colorScheme.primary
		"paused", "cancelled" -> MaterialTheme.colorScheme.outline
		else -> MaterialTheme.colorScheme.outline
	}
	Box(
		Modifier
			.size(14.dp)
			.clip(CircleShape)
			.background(if (state == "done" || state == "in_progress") color else MaterialTheme.colorScheme.surface)
			.padding(1.dp),
	) {
		if (state != "done" && state != "in_progress") {
			Box(Modifier.fillMaxSize().clip(CircleShape).background(MaterialTheme.colorScheme.surface))
		}
	}
}

@Composable
private fun BoardSectionLabel(label: String, trailing: (@Composable () -> Unit)? = null) {
	Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
		Text(
			label.uppercase(),
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Spacer(Modifier.weight(1f))
		trailing?.let { it() }
	}
}

@Composable
private fun SessionGroupHeader(state: ChatState, key: GroupKey) {
	// No team in the roster means the session ended or the roster is between refreshes; the stored
	// key's own leaf is the honest label then, never a guess at some other machine's session.
	val label = state.teamForSessionKey(key.gatewayId, key.sessionId)
		?.let { state.label(it) }
		?: key.sessionId.substringAfterLast('.')
	Card(Modifier.fillMaxWidth()) {
		Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
			Text(
				label,
				style = MaterialTheme.typography.titleSmall,
				fontFamily = FontFamily.Monospace,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
			)
		}
	}
}

/** Tighter than a default button, so the pair fits beside the form's title without wrapping. */
private val FORM_BUTTON_PADDING = PaddingValues(horizontal = 18.dp, vertical = 6.dp)

/** The new-entry form, in place of the list. Save is disabled on a blank title, since a titleless
 * entry renders as an empty row everywhere the board is drawn. */
@Composable
private fun BoardComposeForm(
	title: String,
	body: String,
	onTitle: (String) -> Unit,
	onBody: (String) -> Unit,
	onCancel: () -> Unit,
	onSave: () -> Unit,
	modifier: Modifier = Modifier,
) {
	Column(
		modifier.fillMaxSize().padding(horizontal = 12.dp).verticalScroll(rememberScrollState()),
		verticalArrangement = Arrangement.spacedBy(10.dp),
	) {
		Row(
			Modifier.fillMaxWidth().padding(top = 10.dp),
			horizontalArrangement = Arrangement.spacedBy(8.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Text("New entry", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
			// Outlined against filled, rather than two flat labels: Save is the one the form exists for,
			// and a pair of bare words reads as text rather than as the two ways out of the screen.
			OutlinedButton(onClick = onCancel, contentPadding = FORM_BUTTON_PADDING) { Text("Cancel") }
			Button(onClick = onSave, enabled = title.isNotBlank(), contentPadding = FORM_BUTTON_PADDING) { Text("Save") }
		}
		OutlinedTextField(
			value = title,
			onValueChange = onTitle,
			label = { Text("Title") },
			singleLine = true,
			modifier = Modifier.fillMaxWidth(),
		)
		OutlinedTextField(
			value = body,
			onValueChange = onBody,
			label = { Text("Body") },
			minLines = 6,
			modifier = Modifier.fillMaxWidth(),
		)
	}
}

@Composable
private fun BoardFoldRow(label: String, expanded: Boolean, onToggle: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().combinedClickable(onClick = onToggle).padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(
			if (expanded) Icons.Default.ExpandMore else Icons.AutoMirrored.Filled.KeyboardArrowRight,
			contentDescription = if (expanded) "Collapse" else "Expand",
			tint = MaterialTheme.colorScheme.onSurfaceVariant,
			modifier = Modifier.size(20.dp),
		)
		Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	}
}

@Composable
private fun SheetAction(label: String, onClick: () -> Unit) {
	Text(
		label,
		style = MaterialTheme.typography.bodyLarge,
		modifier = Modifier.fillMaxWidth().combinedClickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 14.dp),
	)
}

private fun stateLabel(state: String): String = when (state) {
	"in_progress" -> "in progress"
	else -> state
}

/** A non-route column older than this reads as stale; below it the cadence is working as intended. */
private const val STALE_AFTER_MS = 5 * 60 * 1000L

private const val TRASH_WINDOW_MS = 30L * 24 * 60 * 60 * 1000

private fun relativeAge(at: Long): String {
	val delta = System.currentTimeMillis() - at
	return when {
		delta < 3_600_000 -> "${delta / 60_000}m"
		delta < 86_400_000 -> "${delta / 3_600_000}h"
		else -> "${delta / 86_400_000}d"
	}
}

/** Days left before the trash sweep takes an entry, so the 30-day window is legible per row. */
private fun daysLeftInTrash(trashedAt: Long): Int {
	val remaining = TRASH_WINDOW_MS - (System.currentTimeMillis() - trashedAt)
	return ((remaining + 86_399_999) / 86_400_000).coerceAtLeast(0).toInt()
}
