package com.atelier_nyaarium.switchboard.board

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.atelier_nyaarium.switchboard.AttachmentViewer
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.OpenAttachment

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
	repo: ChatRepository,
	gatewayId: String,
	entryId: String,
	onClose: () -> Unit,
) {
	val revision by repo.boardOps.boardRevision
	val entry = remember(revision, entryId) { repo.boardOps.boardEntriesOn(gatewayId).firstOrNull { it.id == entryId } }
	if (entry == null) {
		onClose()
		return
	}

	// What the editor opened with. Save compares against THIS, not the live entry: an agent's write
	// landing mid-edit would otherwise make an untouched field look changed and revert their edit.
	val baseline = remember(entryId) { entry.title to entry.body.orEmpty() }
	var title by remember(entryId) { mutableStateOf(baseline.first) }
	var body by remember(entryId) { mutableStateOf(baseline.second) }
	var viewer by remember { mutableStateOf<OpenAttachment?>(null) }
	val changedElsewhere = entry.title != baseline.first || entry.body.orEmpty() != baseline.second
	val children = remember(revision, entryId) {
		repo.boardOps.boardEntriesOn(gatewayId).filter { it.parent == entryId && it.trashedAt == null }.sortedBy { it.rank }
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
					// Filled, like the form's own Save: a bare word in a bar reads as a title, not a control.
					Button(
						onClick = {
							saveEntryFields(repo, gatewayId, entryId, title, body, baseline)
							onClose()
						},
						contentPadding = PaddingValues(horizontal = 18.dp, vertical = 6.dp),
						modifier = Modifier.padding(end = 8.dp).height(36.dp),
					) { Text("Save") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			BoardEntryEditor(
				repo = repo,
				gatewayId = gatewayId,
				entry = entry,
				title = title,
				onTitle = { title = it },
				body = body,
				onBody = { body = it },
				changedElsewhere = changedElsewhere,
				children = children,
				onOpenAttachment = { viewer = it },
				onClose = onClose,
			)
		}
	}

	// After the Scaffold, so it overlays the screen and its own back handler wins. Composed inside the
	// scrolling column instead, it lays out inline and shows a strip of controls with no picture.
	viewer?.let { att ->
		AttachmentViewer(att = att, onOpenWith = { viewer = null }, onDismiss = { viewer = null })
	}
}

/**
 * One entry as a modal over whatever opened it, for the thread's board strip.
 *
 * Tap-away is off: the body is a text field, and a stray touch beside the dialog must not discard a
 * half-typed edit. Back still dismisses, being deliberate.
 */
@Composable
fun BoardEntryDialog(repo: ChatRepository, gatewayId: String, entryId: String, onClose: () -> Unit) {
	val revision by repo.boardOps.boardRevision
	val entry = remember(revision, entryId) { repo.boardOps.boardEntriesOn(gatewayId).firstOrNull { it.id == entryId } }
	if (entry == null) {
		onClose()
		return
	}
	val baseline = remember(entryId) { entry.title to entry.body.orEmpty() }
	var title by remember(entryId) { mutableStateOf(baseline.first) }
	var body by remember(entryId) { mutableStateOf(baseline.second) }
	var viewer by remember { mutableStateOf<OpenAttachment?>(null) }
	val changedElsewhere = entry.title != baseline.first || entry.body.orEmpty() != baseline.second
	val children = remember(revision, entryId) {
		repo.boardOps.boardEntriesOn(gatewayId).filter { it.parent == entryId && it.trashedAt == null }.sortedBy { it.rank }
	}

	Dialog(onDismissRequest = onClose, properties = DialogProperties(dismissOnClickOutside = false)) {
		Surface(shape = RoundedCornerShape(28.dp), tonalElevation = 6.dp) {
			Column(
				Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()).padding(20.dp),
				verticalArrangement = Arrangement.spacedBy(14.dp),
			) {
				Text(entry.title, style = MaterialTheme.typography.titleMedium, maxLines = 2)
				BoardEntryEditor(
					repo = repo,
					gatewayId = gatewayId,
					entry = entry,
					title = title,
					onTitle = { title = it },
					body = body,
					onBody = { body = it },
					changedElsewhere = changedElsewhere,
					children = children,
					onOpenAttachment = { viewer = it },
					onClose = onClose,
				)
				Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
					TextButton(onClick = onClose) { Text("Cancel") }
					Button(
						onClick = {
							saveEntryFields(repo, gatewayId, entry.id, title, body, baseline)
							onClose()
						},
					) { Text("Save") }
				}
			}
		}
	}

	viewer?.let { att ->
		AttachmentViewer(att = att, onOpenWith = { viewer = null }, onDismiss = { viewer = null })
	}
}

/** Title and body commit on Save; everything else commits on tap. Shared by the full-screen route and
 * the thread's modal so the two cannot drift into different editors. */
@Composable
private fun BoardEntryEditor(
	repo: ChatRepository,
	gatewayId: String,
	entry: com.atelier_nyaarium.switchboard.proto.BoardEntry,
	title: String,
	onTitle: (String) -> Unit,
	body: String,
	onBody: (String) -> Unit,
	changedElsewhere: Boolean,
	children: List<com.atelier_nyaarium.switchboard.proto.BoardEntry>,
	onOpenAttachment: (OpenAttachment) -> Unit,
	onClose: () -> Unit,
) {
	val entryId = entry.id
	Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
		run {
			if (changedElsewhere) {
				Text(
					"Changed elsewhere since you opened this. Saving keeps only the fields you edited.",
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.error,
				)
			}

			FieldLabel("Title")
			OutlinedTextField(value = title, onValueChange = onTitle, modifier = Modifier.fillMaxWidth())

			FieldLabel("Body")
			OutlinedTextField(
				value = body,
				onValueChange = onBody,
				modifier = Modifier.fillMaxWidth().heightIn(min = 110.dp),
			)

			FieldLabel("State")
			// Wraps: five chips do not fit one row in a dialog, and a plain Row squeezes the last one
			// into a column of letters and pushes the fifth off the edge entirely.
			FlowRow(
				horizontalArrangement = Arrangement.spacedBy(7.dp),
				verticalArrangement = Arrangement.spacedBy(7.dp),
				modifier = Modifier.fillMaxWidth(),
			) {
				for (s in STATES) {
					AssistChip(
						onClick = { repo.boardOps.boardSetState(gatewayId, entryId, s) },
						label = { Text(stateChipLabel(s), style = MaterialTheme.typography.labelSmall) },
						colors = if (s == entry.state) {
							AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
						} else {
							AssistChipDefaults.assistChipColors()
						},
					)
				}
			}

			// Commits on TAP like the state chips, not on Save: an absolute set of the whole list is
			// non-clobbering, so making the owner press Save would only add a step - and Save exists to
			// protect the title and body a refused write has to hand back to a composer.
			FieldLabel("Attachments")
			BoardAttachments(
				attachments = entry.attachments ?: emptyList(),
				repo = repo,
				entryId = entryId,
				onPick = { picked ->
					repo.boardOps.boardSetAttachments(gatewayId, entryId, entry.attachments ?: emptyList(), picked)
				},
				onRemove = { gone ->
					repo.boardOps.boardSetAttachments(
						gatewayId,
						entryId,
						(entry.attachments ?: emptyList()).filter { it.blobId != gone.blobId },
						emptyList(),
					)
				},
				onOpen = onOpenAttachment,
			)

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
							repo.boardOps.boardSetTrashed(gatewayId, entryId, entry.trashedAt == null)
							onClose()
						}
						.padding(horizontal = 14.dp, vertical = 13.dp),
				)
			}
		}
	}
}

/** Both hosts save the same way, so the rule about what a refused write hands back lives in one place. */
private fun saveEntryFields(
	repo: ChatRepository,
	gatewayId: String,
	entryId: String,
	title: String,
	body: String,
	baseline: Pair<String, String>,
) {
	if (title.isNotBlank() && title != baseline.first) repo.boardOps.boardSetTitle(gatewayId, entryId, title.trim())
	if (body != baseline.second) repo.boardOps.boardSetBody(gatewayId, entryId, body.ifBlank { null })
}

@Composable
private fun FieldLabel(text: String) {
	Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

private fun stateChipLabel(state: String): String = if (state == "in_progress") "In progress" else state.replaceFirstChar { it.uppercase() }
