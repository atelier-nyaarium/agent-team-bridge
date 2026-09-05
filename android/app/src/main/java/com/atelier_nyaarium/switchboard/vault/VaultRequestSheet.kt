package com.atelier_nyaarium.switchboard.vault

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.VaultDraft
import com.atelier_nyaarium.switchboard.hapticClick
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The brief names the operation; the owner picks how long the approval holds. */
@Composable
fun VaultRequestSheet(
	repo: ChatRepository,
	state: ChatState,
	requestId: String,
	onClose: () -> Unit,
) {
	val pending by repo.vault.pending.collectAsState()
	val request = pending.firstOrNull { it.requestId == requestId }
	if (request == null) {
		onClose()
		return
	}
	val activity = LocalContext.current as? FragmentActivity
	val scope = rememberCoroutineScope()
	val revision by repo.vault.revision
	val entry = remember(revision, request.entryId) { request.entryId?.let { repo.vaultOps.view(it) } }
	var typed by remember(requestId) { mutableStateOf("") }
	var shown by remember(requestId) { mutableStateOf(false) }
	var saveAsEntry by remember(requestId) { mutableStateOf(false) }
	var saveTitle by remember(requestId) { mutableStateOf(request.shape) }
	var busy by remember { mutableStateOf(false) }
	var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
	LaunchedEffect(requestId) {
		while (true) {
			delay(15_000)
			now = System.currentTimeMillis()
		}
	}
	val typedRequest = request.entryId == null

	fun answer(decision: String) {
		busy = true
		scope.launch {
			val approving = decision != VAULT_DECISION_DENY
			if (approving && !repo.vaultOps.ownerPresent(activity)) {
				busy = false
				return@launch
			}
			val value = if (approving && typedRequest) typed else null
			val ok = repo.vaultOps.answer(request, decision, value)
			if (ok && approving && typedRequest && saveAsEntry && saveTitle.isNotBlank()) {
				repo.vaultOps.save(VaultDraft(publicTitle = saveTitle, value = typed))
			}
			busy = false
			if (ok) onClose()
		}
	}

	Dialog(
		onDismissRequest = onClose,
		properties = DialogProperties(dismissOnClickOutside = false, usePlatformDefaultWidth = false),
	) {
		Surface(shape = RoundedCornerShape(28.dp), tonalElevation = 6.dp, modifier = Modifier.fillMaxWidth(0.95f)) {
			Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Text("Vault request", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
					Text(
						expiresIn(request.deadlineAt, now),
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				Text(
					"${requester(state, request)} wants to run",
					style = MaterialTheme.typography.bodyMedium,
				)
				Text(
					request.operation,
					style = MaterialTheme.typography.bodyMedium,
					fontFamily = FontFamily.Monospace,
				)
				if (typedRequest) {
					Text(
						"No entry matches. Type the value to hand over once.",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
					OutlinedTextField(
						value = typed,
						onValueChange = { typed = it },
						singleLine = true,
						label = { Text("Value") },
						visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
						trailingIcon = { TextButton(onClick = { shown = !shown }) { Text(if (shown) "Hide" else "Show") } },
						modifier = Modifier.fillMaxWidth(),
					)
					Row(verticalAlignment = Alignment.CenterVertically) {
						Checkbox(checked = saveAsEntry, onCheckedChange = { saveAsEntry = it })
						Text("Save as entry", style = MaterialTheme.typography.bodyMedium)
					}
					if (saveAsEntry) {
						OutlinedTextField(
							value = saveTitle,
							onValueChange = { saveTitle = it },
							singleLine = true,
							label = { Text("Public title") },
							modifier = Modifier.fillMaxWidth(),
						)
					}
				} else {
					Text(
						"using ${entry?.title ?: request.entryId}",
						style = MaterialTheme.typography.bodyMedium,
					)
					Text(
						"30 minutes covers ${request.shape}. Whole session covers every use of this entry by that session.",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				FlowRow(
					horizontalArrangement = Arrangement.spacedBy(8.dp),
					verticalArrangement = Arrangement.spacedBy(8.dp),
					modifier = Modifier.fillMaxWidth(),
				) {
					OutlinedButton(onClick = hapticClick { answer(VAULT_DECISION_DENY) }, enabled = !busy) { Text("Deny") }
					if (typedRequest) {
						Button(onClick = hapticClick { answer(VAULT_DECISION_ONCE) }, enabled = !busy && typed.isNotEmpty()) {
							Text("Send once")
						}
					} else {
						Button(onClick = hapticClick { answer(VAULT_DECISION_ONCE) }, enabled = !busy) { Text("Once") }
						Button(onClick = hapticClick { answer(VAULT_DECISION_WINDOW) }, enabled = !busy) { Text("30 minutes") }
						Button(onClick = hapticClick { answer(VAULT_DECISION_SESSION) }, enabled = !busy) { Text("Whole session") }
					}
				}
			}
		}
	}
}
