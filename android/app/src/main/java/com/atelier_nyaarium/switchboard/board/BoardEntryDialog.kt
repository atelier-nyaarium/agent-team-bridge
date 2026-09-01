package com.atelier_nyaarium.switchboard.board

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.OpenAttachment

private val STATES = listOf("open", "in_progress", "paused", "done", "cancelled")

/**
 * One entry as a modal over whatever opened it. The only editor: both the thread's strip and the
 * Backlog tab open this one.
 *
 * Everything but title and body commits on TAP - those fields carry no draft, so making them wait
 * would only add a step. Title and body wait for Save, being the only ones a refused write has to
 * hand back to a composer.
 *
 * Tap-away is off: the body is a text field, and a stray touch beside the dialog must not discard a
 * half-typed edit. Back still dismisses, being deliberate.
 */
@Composable
fun BoardEntryDialog(
	state: ChatState,
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
	val baseline = remember(entryId) { entry.title to entry.body.orEmpty() }
	var title by remember(entryId) { mutableStateOf(baseline.first) }
	var body by remember(entryId) { mutableStateOf(baseline.second) }
	var viewer by remember { mutableStateOf<OpenAttachment?>(null) }
	val changedElsewhere = entry.title != baseline.first || entry.body.orEmpty() != baseline.second
	val children = remember(revision, entryId) {
		repo.boardOps.boardEntriesOn(gatewayId).filter { it.parent == entryId && it.trashedAt == null }.sortedBy { it.rank }
	}

	Dialog(
		onDismissRequest = onClose,
		// The platform default is a narrow dialog width, which turns every field into a tall stack.
		properties = DialogProperties(dismissOnClickOutside = false, usePlatformDefaultWidth = false),
	) {
		Surface(
			shape = RoundedCornerShape(28.dp),
			tonalElevation = 6.dp,
			modifier = Modifier.fillMaxWidth(0.95f),
		) {
			// Only the fields scroll. Save and Cancel sit outside it, or a tall entry pushes them past
			// the dialog's own height cap and the owner cannot commit without discovering the scroll.
			Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
				Column(
					Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
					verticalArrangement = Arrangement.spacedBy(14.dp),
				) {
					BoardEntryEditor(
					state = state,
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

/** The editor's fields, split out so the dialog's scroll can hold them while its buttons stay pinned. */
@Composable
private fun BoardEntryEditor(
	state: ChatState,
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

			// Floating labels rather than a caption row above each field: the caption doubled the
			// vertical cost of every field, which is most of why this stack ran off the bottom.
			OutlinedTextField(
				value = title,
				onValueChange = onTitle,
				label = { Text("Title") },
				modifier = Modifier.fillMaxWidth(),
			)
			OutlinedTextField(
				value = body,
				onValueChange = onBody,
				label = { Text("Body") },
				modifier = Modifier.fillMaxWidth().heightIn(min = 110.dp),
			)

			// Commits on tap, like State. Assigning to a session takes the entry off the Backlog tab, so
			// the chip moving is the only confirmation the owner gets that it landed.
			FieldLabel("Session")
			FlowRow(
				horizontalArrangement = Arrangement.spacedBy(7.dp),
				verticalArrangement = Arrangement.spacedBy(7.dp),
				modifier = Modifier.fillMaxWidth(),
			) {
				SessionChip("Backlog", entry.sessionId == null) {
					repo.boardOps.boardAssign(gatewayId, entryId, null)
				}
				for (team in repo.boardOps.boardAssignTargets()) {
					val held = repo.boardOps.boardSessionKeyOf(team.name) == entry.sessionId
					SessionChip(state.label(team.name), held) {
						repo.boardOps.boardAssign(gatewayId, entryId, team.name)
					}
				}
			}

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

			// A text button, not a filled card. Destructive and rarely wanted, so it should not be the
			// most prominent control in the editor.
			TextButton(
				onClick = {
					repo.boardOps.boardSetTrashed(gatewayId, entryId, entry.trashedAt == null)
					onClose()
				},
			) {
				Text(
					if (entry.trashedAt != null) "Restore from trash" else "Move to trash",
					color = MaterialTheme.colorScheme.error,
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

/** One selectable chip, styled the same as the state chips so the two rows read as one control. */
@Composable
private fun SessionChip(label: String, held: Boolean, onClick: () -> Unit) {
	AssistChip(
		onClick = onClick,
		label = { Text(label, style = MaterialTheme.typography.labelSmall) },
		colors = if (held) {
			AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
		} else {
			AssistChipDefaults.assistChipColors()
		},
	)
}

@Composable
private fun FieldLabel(text: String) {
	Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

private fun stateChipLabel(state: String): String = if (state == "in_progress") "In progress" else state.replaceFirstChar { it.uppercase() }
