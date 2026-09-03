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

/** Unassigned entries and trash. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoardScreen(
	repo: ChatRepository,
	onOpenEntry: (String, String) -> Unit,
	onMoveEntry: (BoardRow, BoardDrop) -> Unit = { _, _ -> },
	onSaved: () -> Unit = {},
	modifier: Modifier = Modifier,
) {
	LaunchedEffect(Unit) { repo.boardOps.refreshBoard() }

	val revision by repo.boardOps.boardRevision
	val rows = remember(revision) { flattenBoard(repo.boardOps.boardEntries()) }

	// Expose stale columns explicitly.
	val staleColumns = remember(revision) {
		val route = repo.boardOps.boardGatewayOf(null)
		repo.boardOps.boardSourceGatewayIds()
			.filter { it != route }
			.mapNotNull { gw -> repo.boardOps.boardLastSyncedAt(gw).takeIf { it > 0 }?.let { gw to it } }
			.filter { System.currentTimeMillis() - it.second > STALE_AFTER_MS }
	}

	val truncatedColumns = remember(revision) { repo.boardOps.boardTruncatedGateways() }
	val struggling = remember(revision) { repo.boardOps.boardStrugglingEntries() }

	var trashOpen by rememberSaveable { mutableStateOf(false) }
	// Preserve drafts across tab disposal.
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
		// Refusals and drops are distinct outcomes.
		for ((index, refusal) in repo.boardOps.boardRefusals.withIndex()) {
			item(key = "refused:$index:${refusal.entryId ?: "none"}") {
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
			BoardSectionLabel {
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
				// Trash entries have no live tree position.
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

/** Shared task-state mark. */
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

private val FORM_BUTTON_PADDING = PaddingValues(horizontal = 18.dp, vertical = 6.dp)

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

/** Aligns with row text. */
private val STATE_MARK_SIZE = 16.dp

private val LIST_INSET = 12.dp

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

internal fun daysLeftInTrash(trashedAt: Long): Int {
	val remaining = TRASH_WINDOW_MS - (System.currentTimeMillis() - trashedAt)
	return ((remaining + 86_399_999) / 86_400_000).coerceAtLeast(0).toInt()
}
