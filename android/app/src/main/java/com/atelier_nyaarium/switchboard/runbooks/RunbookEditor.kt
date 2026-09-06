package com.atelier_nyaarium.switchboard.runbooks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.RunbookConflict
import com.atelier_nyaarium.switchboard.RunbookSaved
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.standingConflict
import kotlinx.coroutines.launch

/** Settings are keyed by placeholder name, so deleting one hides them and pasting it back restores them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunbookEditor(repo: ChatRepository, runbookId: String?, onClose: () -> Unit) {
	val existing = remember(runbookId) { runbookId?.let { repo.runbooks.find(it) } }
	var draft by remember(runbookId) {
		mutableStateOf(existing?.let { RunbookDraft.of(it) } ?: RunbookDraft(id = newRunbookId()))
	}
	val declared = draft.declared
	val scope = rememberCoroutineScope()
	var saving by remember(runbookId) { mutableStateOf(false) }
	var refused by remember(runbookId) { mutableStateOf<RunbookConflict?>(null) }

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(if (existing == null) "New runbook" else "Edit runbook") },
				actions = {
					TextButton(onClick = hapticClick(onClose)) { Text("Cancel") }
					Button(
						enabled = draft.refusal() == null && !saving,
						onClick = hapticClick {
							val candidate = draft.toRunbook() ?: return@hapticClick
							saving = true
							refused = null
							scope.launch {
								// A refusal keeps the draft, so the owner can rebase it or walk away.
								when (val saved = repo.runbookOps.save(candidate)) {
									is RunbookSaved.Refused -> refused = saved.conflict
									else -> onClose()
								}
								saving = false
							}
						},
						modifier = Modifier.padding(end = 8.dp),
					) { Text(if (saving) "Saving" else "Save") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			OutlinedTextField(
				value = draft.name,
				onValueChange = { draft = draft.copy(name = it) },
				label = { Text("Name") },
				singleLine = true,
				modifier = Modifier.fillMaxWidth(),
			)
			OutlinedTextField(
				value = draft.body,
				onValueChange = { draft = draft.copy(body = it) },
				label = { Text("Body") },
				supportingText = { Text("{{name}} makes a blank") },
				modifier = Modifier.fillMaxWidth().heightIn(min = 220.dp),
			)

			// A body that does not parse declares nothing, and the refusal below says why.
			for (name in declared.orEmpty()) {
				ParameterCard(
					name = name,
					setting = draft.settingsFor(name),
					onEdit = { edit -> draft = draft.withSettings(name, edit) },
				)
			}

			val standing = refused ?: standingConflict(repo.runbookOps.conflictOf(draft.id), draft.revision)
			standing?.let { conflict ->
				Card(Modifier.fillMaxWidth()) {
					Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
						Text(conflict.reason, style = MaterialTheme.typography.bodyMedium)
						// Saving from their revision is what makes the next push win.
						TextButton(
							onClick = hapticClick {
								draft = draft.copy(revision = conflict.heldRevision)
								refused = null
							},
						) { Text("Overwrite") }
					}
				}
			}

			draft.refusal()?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
			Spacer(Modifier.height(24.dp))
		}
	}
}

@Composable
private fun ParameterCard(name: String, setting: ParameterDraft, onEdit: ((ParameterDraft) -> ParameterDraft) -> Unit) {
	var option by remember(name) { mutableStateOf("") }

	Card(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
			Text("{{$name}}", style = MaterialTheme.typography.titleMedium)
			OutlinedTextField(
				value = setting.label,
				onValueChange = { label -> onEdit { it.copy(label = label) } },
				label = { Text("Label") },
				singleLine = true,
				modifier = Modifier.fillMaxWidth(),
			)
			SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
				SegmentedButton(
					selected = setting.kind == "text",
					onClick = hapticClick { onEdit { it.copy(kind = "text") } },
					shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
				) { Text("Text") }
				SegmentedButton(
					selected = setting.kind == "choice",
					onClick = hapticClick { onEdit { it.copy(kind = "choice") } },
					shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
				) { Text("Choice") }
			}

			if (setting.kind == "choice") {
				FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
					for (held in setting.options) {
						InputChip(
							selected = setting.default == held,
							onClick = hapticClick { onEdit { it.copy(default = if (it.default == held) "" else held) } },
							label = { Text(held) },
							trailingIcon = {
								IconButton(onClick = hapticClick {
									onEdit { it.copy(options = it.options - held, default = if (it.default == held) "" else it.default) }
								}) { Icon(Icons.Default.Close, contentDescription = "Remove $held") }
							},
						)
					}
				}
				Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
					OutlinedTextField(
						value = option,
						onValueChange = { option = it },
						label = { Text("Option") },
						singleLine = true,
						modifier = Modifier.weight(1f),
					)
					TextButton(
						enabled = option.isNotBlank() && option !in setting.options,
						onClick = hapticClick {
							onEdit { it.copy(options = it.options + option.trim()) }
							option = ""
						},
					) { Text("Add") }
				}
			} else {
				OutlinedTextField(
					value = setting.default,
					onValueChange = { value -> onEdit { it.copy(default = value) } },
					label = { Text("Default") },
					singleLine = true,
					modifier = Modifier.fillMaxWidth(),
				)
			}
		}
	}
}
