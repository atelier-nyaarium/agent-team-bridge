package com.atelier_nyaarium.switchboard

import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import com.atelier_nyaarium.switchboard.proto.CrossDomainListenResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

////////////////////////////////
//  The Link pairing ceremony (the both-present cross-Domain handshake)

/**
 * The mutual link ceremony, a transient overlay (leaving it cancels the pairing windows, so there
 * is no passive cross-Domain surface). Two steps: a RENDEZVOUS where one owner shares a code and
 * the other enters it, then a VERIFY where both compute a safety code and each types the code the
 * other sends. Confirm unlocks only on an exact local match, the anti-MITM gate.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LinkWizard(repo: ChatRepository, onDone: () -> Unit, onCancel: () -> Unit) {
	val scope = rememberCoroutineScope()

	// Wizard state.
	var role by remember { mutableStateOf<LinkRole?>(null) }
	var step by remember { mutableStateOf<LinkStep>(LinkStep.Rendezvous) }

	// Receiver: the open listening window, and the pairing once a requester lands (via listen-state poll).
	var listening by remember { mutableStateOf<CrossDomainListenResult?>(null) }
	var receiverPairing by remember { mutableStateOf<CrossDomainReceiverPairing?>(null) }
	// Requester: the friend's listening token (entered) and the pairing once the exchange runs.
	var enteredToken by remember { mutableStateOf("") }
	var pairing by remember { mutableStateOf<CrossDomainPairing?>(null) }
	// Pinned for the life of this pairing so a confirm retry reuses the same signed link bytes.
	val linkNonce = remember { repo.trust.freshLinkNonce() }

	var typed by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	var note by remember { mutableStateOf("") }

	// Leaving the screen closes the pairing windows on the gateway so a stale request cannot
	// complete after the owner walked away.
	androidx.compose.runtime.DisposableEffect(Unit) {
		onDispose {
			val tok = listening?.listeningToken
			val pin = pairing?.pin
			// The close must outlive this composable, so it runs on a detached scope. The gateway
			// also sweeps on its TTL, so a dropped cancel is bounded.
			if (tok != null || pin != null) {
				@Suppress("OPT_IN_USAGE")
				repo.repoScope.launch { runCatchingCancellable { repo.trust.crossDomainCancel(tok, pin) } }
			}
		}
	}

	fun fail(reason: String) {
		step = LinkStep.Failed(reason)
	}

	// RECEIVER poll: while the listening window is open on the rendezvous step, poll the gateway
	// for the requester's pairing. On arrival, stash the friend keys + SAS and move to verify.
	// Keyed by the token so a fresh listen restarts the loop.
	val openToken = listening?.listeningToken
	LaunchedEffect(openToken, step) {
		if (role != LinkRole.RECEIVER || openToken == null || step !is LinkStep.Rendezvous) return@LaunchedEffect
		while (step is LinkStep.Rendezvous) {
			val outcome = repo.trust.crossDomainListenState(openToken)
			val arrived = outcome.getOrNull()
			if (arrived != null) {
				receiverPairing = arrived
				step = LinkStep.Verify(arrived.sas)
				break
			}
			delay(LISTEN_POLL_MS)
		}
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(if (role == null) "Link with a peer" else "Link") },
				navigationIcon = {
					IconButton(onClick = hapticClick(onCancel)) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Cancel")
					}
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(20.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(20.dp),
		) {
			when (val s = step) {
				is LinkStep.Rendezvous -> RendezvousPanel(
					role = role,
					listening = listening,
					enteredToken = enteredToken,
					busy = busy,
					note = note,
					onPickReceiver = {
						role = LinkRole.RECEIVER
						busy = true
						note = ""
						scope.launch {
							repo.trust.crossDomainListen()
								.onSuccess { listening = it }
								.onFailure { fail("Could not open a listening window: ${it.message?.take(140)}") }
							busy = false
						}
					},
					onPickRequester = {
						role = LinkRole.REQUESTER
						note = ""
					},
					onTokenChange = { enteredToken = it },
					onRequest = {
						busy = true
						note = ""
						scope.launch {
							repo.trust.crossDomainRequest(enteredToken)
								.onSuccess { p ->
									pairing = p
									step = LinkStep.Verify(CrossDomainLink.requesterSas(p.result))
								}
								.onFailure { fail(humanizeHandshakeError(it.message)) }
							busy = false
						}
					},
				)

				is LinkStep.Verify -> VerifyPanel(
					mySas = s.mySas,
					typed = typed,
					busy = busy,
					confirmEnabled = CrossDomainLink.sasMatches(s.mySas, typed) && !busy,
					onTypedChange = { typed = it },
					onConfirm = {
						busy = true
						scope.launch {
							// Each owner confirms independently with its own signed link side: the requester
							// signs over the receiver keys from its request pairing; the receiver signs over
							// the friend keys it learned from the listen-state poll.
							val confirm: Result<ConfirmOutcome> = when (role) {
								LinkRole.REQUESTER -> {
									val p = pairing
									if (p == null) Result.failure(IllegalStateException("The pairing was lost; start over."))
									else repo.trust.crossDomainConfirmRequester(p, linkNonce)
								}

								LinkRole.RECEIVER -> {
									val token = listening?.listeningToken
									val friend = receiverPairing
									if (token == null || friend == null) {
										Result.failure(IllegalStateException("The pairing was lost; start over."))
									} else {
										repo.trust.crossDomainConfirmReceiver(token, friend, linkNonce)
									}
								}

								null -> Result.failure(IllegalStateException("No role selected; start over."))
							}
							// On success the local peer write landed, but the edge submit may still have been
							// rejected by the Router (RelayEdgeRejected): linked locally, cross-Domain sends
							// denied. Surface that distinct state with a retry rather than a false "Linked".
							confirm
								.onSuccess { outcome ->
									step = when (outcome) {
										is ConfirmOutcome.Linked -> LinkStep.Done
										is ConfirmOutcome.RelayEdgeRejected -> LinkStep.LinkedNoRelay(outcome.peerDomainId)
									}
								}
								.onFailure { fail(humanizeHandshakeError(it.message)) }
							busy = false
						}
					},
					onAbort = onCancel,
				)

				is LinkStep.LinkedNoRelay -> LinkedNoRelayPanel(
					busy = busy,
					onRetry = {
						busy = true
						scope.launch {
							repo.trust.retryXdomainLinkEdge(s.peerDomainId)
								.onSuccess { outcome ->
									step = when (outcome) {
										is ConfirmOutcome.Linked -> LinkStep.Done
										// Still rejected: stay on this panel so Retry can fire again (no relink).
										is ConfirmOutcome.RelayEdgeRejected -> LinkStep.LinkedNoRelay(outcome.peerDomainId)
									}
								}
								.onFailure { note = humanizeHandshakeError(it.message) }
							busy = false
						}
					},
					note = note,
					onDone = onDone,
				)

				is LinkStep.Done -> DonePanel(onDone)
				is LinkStep.Failed -> FailedPanel(reason = s.reason, onRestart = {
					role = null
					listening = null
					receiverPairing = null
					enteredToken = ""
					pairing = null
					typed = ""
					note = ""
					step = LinkStep.Rendezvous
				}, onClose = onCancel)
			}
		}
	}
}

////////////////////////////////
//  Panels

@Composable
private fun RendezvousPanel(
	role: LinkRole?,
	listening: CrossDomainListenResult?,
	enteredToken: String,
	busy: Boolean,
	note: String,
	onPickReceiver: () -> Unit,
	onPickRequester: () -> Unit,
	onTokenChange: (String) -> Unit,
	onRequest: () -> Unit,
) {
	Text(
		"One of you shares a code; the other enters it. Send it however works (text, etc).",
		style = MaterialTheme.typography.bodyMedium,
	)
	if (note.isNotEmpty()) InfoSurface(note)

	when (role) {
		null -> {
			Spacer(Modifier.height(8.dp))
			Button(onClick = hapticClick(onPickReceiver), modifier = Modifier.fillMaxWidth()) { Text("Show my code") }
			OutlinedButton(onClick = hapticClick(onPickRequester), modifier = Modifier.fillMaxWidth()) { Text("Enter my friend's code") }
		}

		LinkRole.RECEIVER -> {
			if (busy || listening == null) {
				Busy("Generating your code...")
			} else {
				Text("Send this code to your friend:", style = MaterialTheme.typography.titleMedium)
				CodeBlock(listening.listeningToken)
				CopyButton(listening.listeningToken)
				InfoSurface(
					"You can send it and come back - this stays open.",
				)
				Busy("Waiting for your friend to enter the code...")
			}
		}

		LinkRole.REQUESTER -> {
			Text("Enter the code your friend sent you:", style = MaterialTheme.typography.titleMedium)
			OutlinedTextField(
				value = enteredToken,
				onValueChange = onTokenChange,
				label = { Text("Friend's code") },
				singleLine = true,
				modifier = Modifier.fillMaxWidth(),
			)
			Button(
				onClick = hapticClick(onRequest),
				enabled = enteredToken.isNotBlank() && !busy,
				modifier = Modifier.fillMaxWidth(),
			) { Text(if (busy) "Pairing..." else "Pair") }
			if (busy) Busy("Exchanging keys securely...")
		}
	}
}

@Composable
private fun VerifyPanel(
	mySas: String,
	typed: String,
	busy: Boolean,
	confirmEnabled: Boolean,
	onTypedChange: (String) -> Unit,
	onConfirm: () -> Unit,
	onAbort: () -> Unit,
) {
	Text("Confirm the safety code", style = MaterialTheme.typography.titleLarge)
	Text(
		"Compare codes with your friend. They must match exactly - a mismatch means a key was tampered with, so abort.",
		style = MaterialTheme.typography.bodyMedium,
	)
	Text("Yours (copy + send):", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
	CodeBlock(grouped(mySas))
	CopyButton(mySas)
	OutlinedTextField(
		value = typed,
		onValueChange = onTypedChange,
		label = { Text("Type your friend's code") },
		singleLine = true,
		keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
		modifier = Modifier.fillMaxWidth(),
	)
	if (typed.isNotEmpty() && !confirmEnabled && !busy) {
		Text(
			"Does not match yet. The full code is ${CrossDomainLink.SAS_DIGITS} digits.",
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.error,
		)
	}
	Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
		OutlinedButton(onClick = hapticClick(onAbort), enabled = !busy, modifier = Modifier.weight(1f)) { Text("Abort") }
		Button(onClick = hapticClick(onConfirm), enabled = confirmEnabled, modifier = Modifier.weight(1f)) {
			Text(if (busy) "Linking..." else "Confirm")
		}
	}
	if (busy) Busy("Writing the link on both sides...")
}

@Composable
private fun DonePanel(onDone: () -> Unit) {
	Text("Linked", style = MaterialTheme.typography.titleLarge)
	InfoSurface(
		"Linked on both sides. Choose what to share from the peer's detail; nothing is shared until you pick it.",
	)
	Button(onClick = hapticClick(onDone), modifier = Modifier.fillMaxWidth()) { Text("Done") }
}

/** Trust is written locally, but the Router did not authorize the relay edge, so cross-Domain sends
 * would be denied. Retry just the edge (idempotent at the Router, no unlink+relink). Closing leaves
 * the peer linked locally; the user can retry later. */
@Composable
private fun LinkedNoRelayPanel(busy: Boolean, note: String, onRetry: () -> Unit, onDone: () -> Unit) {
	Text("Linked locally - relay not authorized", style = MaterialTheme.typography.titleLarge)
	Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
		Text(
			"The link is saved, but the Router hasn't authorized relay between your Domains, " +
				"so your agents can't reach this peer yet. Retry - no need to unlink.",
			Modifier.padding(16.dp).fillMaxWidth(),
			color = MaterialTheme.colorScheme.onErrorContainer,
			style = MaterialTheme.typography.bodyMedium,
		)
	}
	if (note.isNotEmpty()) InfoSurface(note)
	Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
		OutlinedButton(onClick = hapticClick(onDone), enabled = !busy, modifier = Modifier.weight(1f)) { Text("Later") }
		Button(onClick = hapticClick(onRetry), enabled = !busy, modifier = Modifier.weight(1f)) {
			Text(if (busy) "Retrying..." else "Retry")
		}
	}
	if (busy) Busy("Authorizing relay...")
}

@Composable
private fun FailedPanel(reason: String, onRestart: () -> Unit, onClose: () -> Unit) {
	Text("Link not completed", style = MaterialTheme.typography.titleLarge)
	Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
		Text(
			reason,
			Modifier.padding(16.dp).fillMaxWidth(),
			color = MaterialTheme.colorScheme.onErrorContainer,
			style = MaterialTheme.typography.bodyMedium,
		)
	}
	Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
		OutlinedButton(onClick = hapticClick(onClose), modifier = Modifier.weight(1f)) { Text("Close") }
		Button(onClick = hapticClick(onRestart), modifier = Modifier.weight(1f)) { Text("Start over") }
	}
}

////////////////////////////////
//  Bits

// Copies the raw value (no spacing) so it pastes cleanly; the displayed CodeBlock keeps the
// grouped/spaced form.
@Composable
private fun CopyButton(value: String) {
	val clipboard = LocalClipboard.current
	val scope = rememberCoroutineScope()
	OutlinedButton(onClick = hapticClick {
		scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("code", value))) }
	}) { Text("Copy") }
}

////////////////////////////////
//  Helpers

// How often the receiver polls the gateway for the requester's pairing.
private const val LISTEN_POLL_MS = 2000L

// Busy / InfoSurface / grouped are shared with the enroll ceremony (Federation.kt).

/** Map a raw handshake error to a calmer, actionable line for the failed panel. */
private fun humanizeHandshakeError(message: String?): String {
	val m = message ?: "Something went wrong."
	return when {
		m.contains("too many pairing attempts", ignoreCase = true) ->
			"Too many tries on that code. Ask your friend for a fresh code, then Start over."
		m.contains("no open listening window", ignoreCase = true) ->
			"That code is no longer active. Ask your friend to show their code again, then start over."
		m.contains("safety code mismatch", ignoreCase = true) || m.contains("substituted in transit", ignoreCase = true) ->
			"The keys did not match (possible tampering). The link was refused - do not retry blindly."
		m.contains("malformed listening token", ignoreCase = true) ->
			"That isn't a valid code. Re-enter the one your friend sent you."
		m.contains("must name a different Gateway", ignoreCase = true) ->
			"That is your own code. Enter your friend's code instead."
		else -> m.take(180)
	}
}
