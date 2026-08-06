package com.atelier_nyaarium.switchboard.board

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState

private val STATES = listOf("open", "in_progress", "paused", "done", "cancelled")

/**
 * One entry, full screen (the body is multiline; a dialog would fight the keyboard).
 *
 * State and placement commit on TAP - they carry no draft, so making them wait would only add a
 * step. Title and body wait for Save, because they are the only fields a refused write has to hand
 * back to a composer.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoardEditScreen(
	state: ChatState,
	repo: ChatRepository,
	gatewayId: String,
	entryId: String,
	onClose: () -> Unit,
) {
	val revision by repo.board.revision
	val entry = remember(revision, entryId) { repo.board.mergedEntries(gatewayId).firstOrNull { it.id == entryId } }
	if (entry == null) {
		onClose()
		return
	}

	// What the editor opened with. Save compares against THIS, not the live entry: an agent's write
	// landing mid-edit would otherwise make an untouched field look changed and revert their edit.
	val baseline = remember(entryId) { entry.title to entry.body.orEmpty() }
	var title by remember(entryId) { mutableStateOf(baseline.first) }
	var body by remember(entryId) { mutableStateOf(baseline.second) }
	val changedElsewhere = entry.title != baseline.first || entry.body.orEmpty() != baseline.second
	val children = remember(revision, entryId) {
		repo.board.mergedEntries(gatewayId).filter { it.parent == entryId && it.trashedAt == null }.sortedBy { it.rank }
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Edit entry") },
				navigationIcon = {
					IconButton(onClick = onClose) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
				actions = {
					TextButton(onClick = {
						if (title.isNotBlank() && title != baseline.first) repo.boardSetTitle(gatewayId, entryId, title.trim())
						if (body != baseline.second) repo.boardSetBody(gatewayId, entryId, body.ifBlank { null })
						onClose()
					}) { Text("Save") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			if (changedElsewhere) {
				Text(
					"Changed elsewhere since you opened this. Saving keeps only the fields you edited.",
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.error,
				)
			}

			FieldLabel("Title")
			OutlinedTextField(value = title, onValueChange = { title = it }, modifier = Modifier.fillMaxWidth())

			FieldLabel("Body")
			OutlinedTextField(
				value = body,
				onValueChange = { body = it },
				modifier = Modifier.fillMaxWidth().heightIn(min = 110.dp),
			)

			FieldLabel("State")
			Row(horizontalArrangement = Arrangement.spacedBy(7.dp), modifier = Modifier.fillMaxWidth()) {
				for (s in STATES) {
					AssistChip(
						onClick = { repo.boardSetState(gatewayId, entryId, s) },
						label = { Text(stateChipLabel(s), style = MaterialTheme.typography.labelSmall) },
						colors = if (s == entry.state) {
							AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
						} else {
							AssistChipDefaults.assistChipColors()
						},
					)
				}
			}

			FieldLabel("Placement")
			PlacementRow(
			"Session",
			entry.sessionId?.let { key ->
				state.teamForSessionKey(gatewayId, key)?.let { state.label(it, state.localGatewayId) }
					?: key.substringAfterLast('.')
			} ?: "Unassigned",
		)
			PlacementRow("Under", children.let { entry.parent?.let { p -> shortId(p) } ?: "Nothing, top level" })

			if (children.isNotEmpty()) {
				FieldLabel("Children")
				Card(Modifier.fillMaxWidth()) {
					Column(Modifier.padding(vertical = 4.dp)) {
						for (kid in children) {
							Row(
								Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 7.dp),
								horizontalArrangement = Arrangement.spacedBy(10.dp),
								verticalAlignment = Alignment.CenterVertically,
							) {
								StateMark(kid.state)
								Text(kid.title, style = MaterialTheme.typography.bodyMedium)
							}
						}
					}
				}
			}

			Card(Modifier.fillMaxWidth()) {
				Text(
					if (entry.trashedAt != null) "Restore from trash" else "Move to trash",
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.error,
					modifier = Modifier
						.fillMaxWidth()
						.clickable {
							repo.boardSetTrashed(gatewayId, entryId, entry.trashedAt == null)
							onClose()
						}
						.padding(horizontal = 14.dp, vertical = 13.dp),
				)
			}
		}
	}
}

@Composable
private fun FieldLabel(text: String) {
	Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun PlacementRow(key: String, value: String) {
	Card(Modifier.fillMaxWidth()) {
		Row(Modifier.padding(horizontal = 14.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
			Text(key, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			Spacer(Modifier.weight(1f))
			Text(value, style = MaterialTheme.typography.bodyMedium)
		}
	}
}

private fun shortId(id: String): String = if (id.length > 8) id.take(8) else id

private fun stateChipLabel(state: String): String = if (state == "in_progress") "In progress" else state.replaceFirstChar { it.uppercase() }
