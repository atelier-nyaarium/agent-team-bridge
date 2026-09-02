package com.atelier_nyaarium.switchboard.board

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.Timelapse
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository

////////////////////////////////
//  The Backlog tab

/**
 * What nobody has claimed, and the trash.
 *
 * Entries a session holds are NOT drawn here; they live on that session's thread strip. So this is a
 * backlog rather than the whole board, and an entry leaves it by being assigned.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoardScreen(
	repo: ChatRepository,
	onOpenEntry: (String, String) -> Unit,
	onMoveEntry: (BoardRow, BoardDrop) -> Unit = { _, _ -> },
	// Where a saved entry leaves the owner. Saving is the end of a thought, and the session list is
	// where they act on it, so the board tab is the one place they do NOT want to land.
	onSaved: () -> Unit = {},
	modifier: Modifier = Modifier,
) {
	// Opening the tab refreshes every non-route Gateway's column (the route one rides the plane).
	LaunchedEffect(Unit) { repo.boardOps.refreshBoard() }

	// The revision read is what re-derives rows when the cache, queue or a plane snapshot moves.
	val revision by repo.boardOps.boardRevision
	val rows = remember(revision) { flattenBoard(repo.boardOps.boardEntries()) }

	// A Gateway whose column could not be refreshed says HOW stale it is: a silently old column is
	// otherwise indistinguishable from a current one.
	val staleColumns = remember(revision) {
		val route = repo.boardOps.boardGatewayOf(null)
		repo.boardOps.boardSourceGatewayIds()
			.filter { it != route }
			.mapNotNull { gw -> repo.boardOps.boardLastSyncedAt(gw).takeIf { it > 0 }?.let { gw to it } }
			.filter { System.currentTimeMillis() - it.second > STALE_AFTER_MS }
	}

	val truncatedColumns = remember(revision) { repo.boardOps.boardTruncatedGateways() }
	// Entries whose queued write keeps failing. A row that looks applied but has not reached the
	// Gateway in many attempts is worth saying out loud, even though it is still retrying.
	val struggling = remember(revision) { repo.boardOps.boardStrugglingEntries() }

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

	val listState = rememberLazyListState()
	val drag = rememberBoardDragController(listState, revision, rows.unassigned.rows, onMoveEntry)

	Box(modifier.fillMaxSize()) {
	LazyColumn(
		state = listState,
		modifier = Modifier.fillMaxSize().padding(horizontal = LIST_INSET).boardDragInput(drag),
		userScrollEnabled = !drag.ui.dragging,
		verticalArrangement = Arrangement.spacedBy(10.dp),
	) {
		// Silence here reads as success, so each gets its own dismissable line. The two kinds are
		// OPPOSITE outcomes and must not share wording: a refusal never landed and can simply be redone,
		// while a drop landed and took the pictures with it for good.
		for ((index, refusal) in repo.boardOps.boardRefusals.withIndex()) {
			item(key = "refused:$index:${refusal.entryId ?: "none"}") {
				// Named rather than left as a floating banner: without the task, the owner has no way to
				// tell which entry lost a picture.
				val named = refusal.entryId?.let { id ->
					repo.boardOps.boardSourceGatewayIds().firstNotNullOfOrNull { gw ->
						repo.boardOps.boardEntriesOn(gw).firstOrNull { it.id == id }?.title
					}
				}
				Row(
					Modifier
						.fillMaxWidth()
						.clickable { repo.boardOps.boardDismissRefusal(refusal) }
						.padding(vertical = 6.dp),
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
			// No section label: the tab is already called Backlog, and repeating it directly under the
			// tab bar says nothing.
			BoardSectionLabel {
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
		if (rows.unassigned.rows.isEmpty()) {
			// Or the tab is a lone button over a blank screen, which reads as a surface that failed to load
			// rather than one with nothing on it.
			item(key = "sect:empty") {
				Text(
					"Nothing waiting. New captures a thought; a session's own tasks live on its thread.",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
				)
			}
		}
		boardRowItems(rows.unassigned.rows, drag, BoardRowPresentation.Board, struggling) {
			onOpenEntry(it.gatewayId, it.entry.id)
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
				// A plain key, not a row key: a trashed entry has no live tree position, and the drag finds
				// its rows by that key alone, so this is what keeps trash out of it.
				for (row in rows.trash) {
					item(key = "trash:${row.entry.id}", contentType = BoardListContentType.Chrome) {
						BoardEntryRow(
							row = row,
							presentation = BoardRowPresentation.Board,
							carried = false,
							struggling = false,
							onClick = { onOpenEntry(row.gatewayId, row.entry.id) },
						)
					}
				}
			}
		}
	}
	BoardDropOverlay(drag, LIST_INSET)
	}
}

/**
 * The task's own state, never the session's - session presence stays on the session card. Public
 * because the session card's live rung and the thread strip draw the same mark.
 *
 * Shape carries the meaning and colour only reinforces it. Every state is a distinct glyph on the
 * same circular footprint, so the marks line up in a list and are still told apart in greyscale.
 * The description is what a screen reader says, and is the only form of this the mark ever had.
 */
@Composable
fun StateMark(state: String) {
	val (icon, tint, label) = when (state) {
		"in_progress" -> Triple(Icons.Filled.Timelapse, MaterialTheme.colorScheme.tertiary, "In progress")
		"done" -> Triple(Icons.Filled.CheckCircle, MaterialTheme.colorScheme.primary, "Done")
		"paused" -> Triple(Icons.Filled.PauseCircle, MaterialTheme.colorScheme.secondary, "Paused")
		"cancelled" -> Triple(Icons.Filled.Cancel, MaterialTheme.colorScheme.outline, "Cancelled")
		else -> Triple(Icons.Outlined.Circle, MaterialTheme.colorScheme.outline, "Open")
	}
	Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(STATE_MARK_SIZE))
}

@Composable
private fun BoardSectionLabel(trailing: @Composable () -> Unit) {
	Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
		Spacer(Modifier.weight(1f))
		trailing()
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
		Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(vertical = 6.dp),
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

/** Matches the row's text line, so a mark never sets the row height. */
private val STATE_MARK_SIZE = 16.dp

/** What the tab puts between the screen edge and a row's start, which the landing line matches. */
private val LIST_INSET = 12.dp

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
internal fun daysLeftInTrash(trashedAt: Long): Int {
	val remaining = TRASH_WINDOW_MS - (System.currentTimeMillis() - trashedAt)
	return ((remaining + 86_399_999) / 86_400_000).coerceAtLeast(0).toInt()
}
