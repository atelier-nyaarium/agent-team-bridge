package com.atelier_nyaarium.switchboard.board

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import com.atelier_nyaarium.switchboard.AttachmentViewer
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.OpenAttachment
import com.atelier_nyaarium.switchboard.proto.BoardAttachment

/**
 * The owner's pictures on one entry: what is there, plus adding and removing.
 *
 * Every action hands the caller the WHOLE list it wants stored, because the board's writes are
 * absolute. There is no add op and no remove op to keep in step.
 */
@Composable
fun BoardAttachments(
	attachments: List<BoardAttachment>,
	repo: ChatRepository,
	entryId: String,
	onPick: (List<Uri>) -> Unit,
	onRemove: (BoardAttachment) -> Unit,
	// Hoisted rather than owned here: AttachmentViewer is a plain composable that overlays whatever
	// was composed before it, so hosting it inside this scrolling column lays it out INLINE and the
	// picture never appears - only a squashed strip of its own controls.
	onOpen: (OpenAttachment) -> Unit,
) {
	val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
		if (uris.isNotEmpty()) onPick(uris)
	}
	val revision by repo.board.revision

	Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
		if (attachments.isNotEmpty()) {
			Card(Modifier.fillMaxWidth()) {
				Column(Modifier.padding(vertical = 4.dp)) {
					for (a in attachments) {
						// Asking for the file is what STARTS the fetch, so a row that has no bytes yet
						// reports which of the three states it is in rather than an endless spinner.
						val file = remember(revision, a.blobId) { repo.boardOps.boardAttachmentFile(entryId, a) }
						val status = if (file != null) null else repo.boardOps.boardAttachmentState(a)
						Row(
							Modifier.fillMaxWidth()
								// One tap does the obvious thing for whichever state the row is in: open
								// what is here, or start the fetch the gallery deliberately did not.
								.clickable(enabled = file != null || status == "manual" || status == "failed") {
									if (file != null) {
										onOpen(OpenAttachment(file, a.filename, a.mime, "", a.size))
									} else {
										repo.boardOps.boardDownloadAttachment(entryId, a)
									}
								}
								.padding(start = 14.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
							horizontalArrangement = Arrangement.spacedBy(8.dp),
							verticalAlignment = Alignment.CenterVertically,
						) {
							Column(Modifier.weight(1f)) {
								Text(a.filename, style = MaterialTheme.typography.bodyMedium)
								Text(
									when (status) {
										"downloading" -> "downloading..."
										"failed" -> "could not download, tap to retry"
										"manual" -> "${describeSize(a.size)}, tap to download"
										null -> describeSize(a.size)
										else -> "not downloaded yet"
									},
									style = MaterialTheme.typography.labelSmall,
									color = if (status == "failed") {
										MaterialTheme.colorScheme.error
									} else {
										MaterialTheme.colorScheme.onSurfaceVariant
									},
								)
							}
							TextButton(onClick = { onRemove(a) }) { Text("Remove") }
						}
					}
				}
			}
		}
		OutlinedButton(onClick = { picker.launch(arrayOf("*/*")) }) {
			Text(if (attachments.isEmpty()) "Attach a file" else "Attach another")
		}
	}
}

/** Rough, and deliberately so: this answers "is this worth opening on data", not an exact byte count. */
internal fun describeSize(bytes: Long): String = when {
	bytes >= 1_000_000 -> "${bytes / 1_000_000} MB"
	bytes >= 1_000 -> "${bytes / 1_000} KB"
	else -> "$bytes bytes"
}
