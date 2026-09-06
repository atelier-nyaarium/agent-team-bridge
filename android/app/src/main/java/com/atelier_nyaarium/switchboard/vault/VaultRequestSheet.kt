package com.atelier_nyaarium.switchboard.vault

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
import com.atelier_nyaarium.switchboard.gatewayOf
import com.atelier_nyaarium.switchboard.hapticClick
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What is asked for, who asks, and the command; the owner picks how long the approval holds. */
@Composable
fun VaultRequestSheet(
	repo: ChatRepository,
	state: ChatState,
	requestId: String,
	onClose: () -> Unit,
) {
	val pending by repo.vault.pending.collectAsState()
	val request = pending.firstOrNull { it.requestId == requestId }
	// A request settled elsewhere closes the sheet after this frame.
	LaunchedEffect(request == null) { if (request == null) onClose() }
	if (request == null) return
	val activity = LocalContext.current as? FragmentActivity
	val scope = rememberCoroutineScope()
	val revision by repo.vault.revision
	val entry = remember(revision, request.entryId) { request.entryId?.let { repo.vaultOps.view(it) } }
	var typed by remember(requestId) { mutableStateOf("") }
	var shown by remember(requestId) { mutableStateOf(false) }
	// Deny opens the steering field; the second Deny sends it, empty or not.
	var steering by remember(requestId) { mutableStateOf(false) }
	var note by remember(requestId) { mutableStateOf("") }
	val steerFocus = remember { FocusRequester() }
	var busy by remember { mutableStateOf(false) }
	var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
	// The ticker also retires the request once its deadline passes.
	LaunchedEffect(requestId) {
		val deadlineAt = request.deadlineAt
		while (true) {
			delay(if (deadlineAt - now < EXPIRY_SECONDS_BELOW_MS) 1_000 else 15_000)
			now = System.currentTimeMillis()
			repo.vault.sweepRequests(now)
		}
	}
	val typedRequest = request.entryId == null
	val expired = request.deadlineAt <= now
	val expiry = expiresIn(request.deadlineAt, now)

	/** A saved typed value takes the shape as its title, which is what the helper matches next time. */
	fun answer(decision: String, save: Boolean = false) {
		busy = true
		scope.launch {
			val approving = decision != VAULT_DECISION_DENY
			// A typed value never prompts: typing it is the owner's act.
			if (approving && !typedRequest && !repo.vaultOps.ownerPresent(activity)) {
				busy = false
				return@launch
			}
			val value = if (approving && typedRequest) typed else null
			val ok = repo.vaultOps.answer(request, decision, value, if (approving) null else note)
			if (ok && approving && typedRequest && save) {
				// The saved entry is scoped to the gateway that asked.
				val gateway = runCatching { gatewayOf(request.team) }.getOrNull()
				repo.vaultOps.save(
					VaultDraft(publicTitle = request.displayShape, value = typed, gateways = listOfNotNull(gateway)),
				)
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
				Column(
					Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
					verticalArrangement = Arrangement.spacedBy(12.dp),
				) {
					Row(verticalAlignment = Alignment.CenterVertically) {
						Text(
							requestTitle(request, entry?.title),
							style = MaterialTheme.typography.titleMedium,
							modifier = Modifier.weight(1f),
						)
						Text(
							expiry.text,
							style = MaterialTheme.typography.labelSmall,
							color = if (expiry.urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
					Text(requester(state, request), style = MaterialTheme.typography.titleSmall)
					Text(
						request.operation,
						style = MaterialTheme.typography.bodyMedium,
						fontFamily = FontFamily.Monospace,
					)
					windowCovers(request)?.let {
						Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
					}
					helperNotice(request)?.let {
						Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
					}
					repeatNotice(request)?.let {
						Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
					}
					if (steering) {
						OutlinedTextField(
							value = note,
							onValueChange = { note = it },
							minLines = 2,
							label = { Text("Steer") },
							modifier = Modifier.fillMaxWidth().focusRequester(steerFocus),
						)
						LaunchedEffect(Unit) { steerFocus.requestFocus() }
					} else if (typedRequest) {
						OutlinedTextField(
							value = typed,
							onValueChange = { typed = it },
							singleLine = true,
							label = { Text("Password") },
							keyboardOptions = SECRET_KEYBOARD,
							visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
							trailingIcon = { TextButton(onClick = { shown = !shown }) { Text(if (shown) "Hide" else "Show") } },
							modifier = Modifier.fillMaxWidth(),
						)
					}
				}
				if (steering) {
					Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
						TextButton(onClick = hapticClick { steering = false }, enabled = !busy) { Text("Back") }
						Spacer(Modifier.weight(1f))
						Button(
							onClick = hapticClick { answer(VAULT_DECISION_DENY) },
							enabled = !busy,
							colors = ButtonDefaults.buttonColors(
								containerColor = MaterialTheme.colorScheme.error,
								contentColor = MaterialTheme.colorScheme.onError,
							),
						) { Text("Deny") }
					}
					return@Column
				}
				Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
					TextButton(onClick = hapticClick { steering = true }, enabled = !busy) { Text("Deny") }
					Spacer(Modifier.weight(1f))
					if (typedRequest) {
						SplitAnswer(
							label = "Send",
							enabled = !busy && !expired && typed.isNotEmpty(),
							onMain = { answer(VAULT_DECISION_ONCE) },
							more = listOf("Send and save" to { answer(VAULT_DECISION_ONCE, save = true) }),
						)
					} else {
						SplitAnswer(
							label = "Approve",
							enabled = !busy && !expired,
							onMain = { answer(VAULT_DECISION_ONCE) },
							// A helper's whole-session answer is recorded as a window, so it is not offered.
							more = if (request.fromHelper) {
								listOf("30 min" to { answer(VAULT_DECISION_WINDOW) })
							} else {
								listOf(
									"30 min" to { answer(VAULT_DECISION_WINDOW) },
									"This session" to { answer(VAULT_DECISION_SESSION) },
								)
							},
						)
					}
				}
			}
		}
	}
}

/** The usual answer as the button; the rest behind the arrow. */
@Composable
private fun SplitAnswer(label: String, enabled: Boolean, onMain: () -> Unit, more: List<Pair<String, () -> Unit>>) {
	var open by remember { mutableStateOf(false) }
	Row(verticalAlignment = Alignment.CenterVertically) {
		Button(
			onClick = hapticClick(onMain),
			enabled = enabled,
			shape = RoundedCornerShape(topStartPercent = 50, topEndPercent = 15, bottomEndPercent = 15, bottomStartPercent = 50),
		) { Text(label) }
		Spacer(Modifier.width(2.dp))
		Box {
			Button(
				onClick = hapticClick { open = true },
				enabled = enabled,
				shape = RoundedCornerShape(topStartPercent = 15, topEndPercent = 50, bottomEndPercent = 50, bottomStartPercent = 15),
				contentPadding = PaddingValues(horizontal = 10.dp),
			) { Icon(Icons.Default.ArrowDropDown, contentDescription = "More") }
			DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
				for ((text, act) in more) {
					DropdownMenuItem(text = { Text(text) }, onClick = {
						open = false
						act()
					})
				}
			}
		}
	}
}
