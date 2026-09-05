package com.atelier_nyaarium.switchboard.vault

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.VaultDraft
import com.atelier_nyaarium.switchboard.VaultSaveOutcome
import com.atelier_nyaarium.switchboard.hapticClick
import kotlinx.coroutines.launch

/** One entry as a modal; a null id composes one. An unrevealed value stays sealed through Save. */
@Composable
fun VaultEntryDialog(
	repo: ChatRepository,
	state: ChatState,
	entryId: String?,
	onClose: () -> Unit,
) {
	val revision by repo.vault.revision
	val existing = remember(revision, entryId) { entryId?.let { repo.vaultOps.view(it) } }
	val gone = entryId != null && existing == null
	// An entry deleted elsewhere closes the editor after this frame.
	LaunchedEffect(gone) { if (gone) onClose() }
	if (gone) return
	val activity = LocalContext.current as? FragmentActivity
	val scope = rememberCoroutineScope()
	var publicTitle by remember(entryId) { mutableStateOf(existing?.publicTitle.orEmpty()) }
	var publicDescription by remember(entryId) { mutableStateOf(existing?.publicDescription.orEmpty()) }
	var privateTitle by remember(entryId) { mutableStateOf(existing?.privateTitle.orEmpty()) }
	var privateDescription by remember(entryId) { mutableStateOf(existing?.privateDescription.orEmpty()) }
	// Null means the sealed value stays as it is.
	var value by remember(entryId) { mutableStateOf<String?>(if (existing?.hasValue == true) null else "") }
	var shown by remember(entryId) { mutableStateOf(false) }
	var gateways by remember(entryId) { mutableStateOf(existing?.gateways) }
	var busy by remember { mutableStateOf(false) }
	var notice by remember { mutableStateOf<String?>(null) }
	var confirmDelete by remember { mutableStateOf(false) }
	val titled = publicTitle.isNotBlank() || privateTitle.isNotBlank()

	fun finish(outcome: VaultSaveOutcome) {
		busy = false
		when (outcome) {
			is VaultSaveOutcome.Applied -> onClose()
			VaultSaveOutcome.Conflict -> notice = "Changed elsewhere since you opened it. Reopen to edit the latest."
			is VaultSaveOutcome.Refused -> notice = "Refused: ${outcome.reason}"
			VaultSaveOutcome.Unreachable -> notice = "The Router could not be reached."
		}
	}

	Dialog(
		onDismissRequest = onClose,
		properties = DialogProperties(dismissOnClickOutside = false, usePlatformDefaultWidth = false),
	) {
		Surface(shape = RoundedCornerShape(28.dp), tonalElevation = 6.dp, modifier = Modifier.fillMaxWidth(0.95f)) {
			Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
				Column(
					Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
					verticalArrangement = Arrangement.spacedBy(12.dp),
				) {
					Text(if (existing == null) "New entry" else existing.title, style = MaterialTheme.typography.titleMedium)
					notice?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
					OutlinedTextField(
						value = publicTitle,
						onValueChange = { publicTitle = it },
						singleLine = true,
						label = { Text("Public title") },
						supportingText = { Text("Agents search public fields.") },
						modifier = Modifier.fillMaxWidth(),
					)
					OutlinedTextField(
						value = publicDescription,
						onValueChange = { publicDescription = it },
						label = { Text("Public description") },
						modifier = Modifier.fillMaxWidth(),
					)
					OutlinedTextField(
						value = privateTitle,
						onValueChange = { privateTitle = it },
						singleLine = true,
						label = { Text("Private title") },
						modifier = Modifier.fillMaxWidth(),
					)
					OutlinedTextField(
						value = privateDescription,
						onValueChange = { privateDescription = it },
						label = { Text("Private description") },
						modifier = Modifier.fillMaxWidth(),
					)
					val held = value
					if (held == null) {
						Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
							TextButton(
								onClick = hapticClick {
									scope.launch {
										if (!repo.vaultOps.ownerPresent(activity)) return@launch
										value = repo.vaultOps.reveal(entryId!!) ?: return@launch
										shown = true
									}
								},
							) { Text("Reveal value") }
							TextButton(onClick = hapticClick { value = "" }) { Text("Clear value") }
						}
					} else {
						OutlinedTextField(
							value = held,
							onValueChange = { value = it },
							label = { Text("Value") },
							keyboardOptions = SECRET_KEYBOARD,
							visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
							textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
							trailingIcon = {
								TextButton(onClick = { shown = !shown }) { Text(if (shown) "Hide" else "Show") }
							},
							modifier = Modifier.fillMaxWidth(),
						)
					}
					if (existing?.gatewaysUnreadable == true && gateways == null) {
						Text(
							"Fields this phone cannot open stay as they are when saved.",
							style = MaterialTheme.typography.labelSmall,
							color = MaterialTheme.colorScheme.error,
						)
					}
					Text("Gateways", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
					FlowRow(
						horizontalArrangement = Arrangement.spacedBy(7.dp),
						verticalArrangement = Arrangement.spacedBy(7.dp),
						modifier = Modifier.fillMaxWidth(),
					) {
						// Every gateway is the one chip that clears the scope; an empty scope admits none.
						ScopeChip("Every gateway", gateways == null && existing?.gatewaysUnreadable != true) { gateways = null }
						for (id in (state.admittedGateways + gateways.orEmpty()).distinct().sorted()) {
							val on = gateways?.contains(id) == true
							ScopeChip(id, on) {
								val current = gateways.orEmpty()
								gateways = if (on) current - id else current + id
							}
						}
					}
				}
				Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					if (existing != null) {
						TextButton(onClick = hapticClick { confirmDelete = true }, enabled = !busy) {
							Text("Delete", color = MaterialTheme.colorScheme.error)
						}
					}
					Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End) {
						TextButton(onClick = onClose) { Text("Cancel") }
						Button(
							enabled = titled && !busy,
							onClick = hapticClick {
								busy = true
								// Changing or clearing a stored value passes the gate, as a reveal does.
								val touchesValue = existing?.hasValue == true && value != null
								scope.launch {
									if (touchesValue && !repo.vaultOps.ownerPresent(activity)) {
										busy = false
										return@launch
									}
									finish(
										repo.vaultOps.save(
											VaultDraft(
												id = entryId,
												publicTitle = publicTitle,
												publicDescription = publicDescription,
												privateTitle = privateTitle,
												privateDescription = privateDescription,
												value = value,
												gateways = gateways,
											),
										),
									)
								}
							},
						) { Text(if (busy) "Saving..." else "Save") }
					}
				}
			}
		}
	}

	if (confirmDelete && entryId != null) {
		AlertDialog(
			onDismissRequest = { confirmDelete = false },
			title = { Text("Delete this entry?") },
			text = { Text("Gateways lose it on their next read. A grant already given stays until it ends.") },
			confirmButton = {
				TextButton(
					onClick = hapticClick {
						confirmDelete = false
						busy = true
						scope.launch { finish(repo.vaultOps.delete(entryId)) }
					},
				) { Text("Delete", color = MaterialTheme.colorScheme.error) }
			},
			dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
		)
	}
}

/** No suggestions and no autocorrect over a secret. */
internal val SECRET_KEYBOARD = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)

@Composable
private fun ScopeChip(label: String, on: Boolean, onClick: () -> Unit) {
	AssistChip(
		onClick = onClick,
		label = { Text(label, style = MaterialTheme.typography.labelSmall) },
		colors = if (on) {
			AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
		} else {
			AssistChipDefaults.assistChipColors()
		},
	)
}
