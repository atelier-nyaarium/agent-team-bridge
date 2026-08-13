package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

////////////////////////////////
//  The FLOW-1 in-person enroll ceremony (admin <-> new-user trust compare)

/**
 * The mutual in-person trust compare, a transient overlay (leaving it cancels the broker window).
 * Both phones run the SAME flow parameterized by an [EnrollCeremonyContext]: commit + reveal through
 * the untrusted evie broker, compute the 6-digit code LOCALLY, then a glance compare - [They match]
 * commits the trust edge, [They differ] / leaving aborts. evie never sees the pin and never computes
 * the code, so a substituted key surfaces here as a diverging code, not a silent MITM.
 *
 * The admin shows the QR on the waiting panel (the new user scans it in person); the enrollee, who
 * already scanned, just waits for the admin to confirm. The compare itself is identical on both.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EnrollCeremonyScreen(
	repo: ChatRepository,
	ctx: EnrollCeremonyContext,
	inviteBlob: String?,
	peerLabel: String,
	onDone: () -> Unit,
	onCancel: () -> Unit,
) {
	val scope = rememberCoroutineScope()
	var step by remember { mutableStateOf<EnrollStep>(EnrollStep.Waiting) }
	var busy by remember { mutableStateOf(false) }
	var note by remember { mutableStateOf("") }
	// Set the moment this phone decides to MATCH. Once set, leaving must NOT cancel the broker window:
	// the peer may still need to poll THIS phone's reveal to finish its own side, and cancelling would
	// strand it with a one-way edge. A decline / undecided walk-away leaves it false, so the window is
	// still torn down on those paths.
	val confirmed = remember { java.util.concurrent.atomic.AtomicBoolean(false) }
	// One owner-link nonce pinned for the whole ceremony so a retry (or a lost-ack re-submit) re-signs
	// the SAME edge bytes, which evie dedupes - rather than accumulating a fresh edge per attempt.
	val edgeNonce = remember { repo.trust.freshLinkNonce() }

	// Drive the commit-reveal exchange the moment the screen opens: commit this side, poll the broker
	// for the peer, verify the binding, compute the code. A failure (mismatch, timeout, transport)
	// lands on the Failed panel.
	LaunchedEffect(ctx.handshakeId, ctx.role) {
		repo.ceremony.enrollExchange(ctx)
			.onSuccess { ex -> step = EnrollStep.Compare(ex.sas, ex) }
			.onFailure { step = EnrollStep.Failed(humanizeEnrollError(it.message)) }
	}

	// Leaving the ceremony BEFORE confirming (back, or an undecided walk-away) tears the broker window
	// down so a half-formed edge cannot complete after the owner left. Once this phone has matched
	// (confirmed=true) the window is left to TTL out instead, so the peer can still poll this phone's
	// reveal and finish its own edge. Best-effort on a detached scope, mirroring the link wizard.
	androidx.compose.runtime.DisposableEffect(ctx.handshakeId, ctx.role) {
		onDispose {
			if (!confirmed.get()) {
				@Suppress("OPT_IN_USAGE")
				kotlinx.coroutines.GlobalScope.launch { runCatching { repo.ceremony.enrollCancel(ctx.handshakeId, ctx.role) } }
			}
		}
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Verify in person") },
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
				is EnrollStep.Waiting -> WaitingPanel(role = ctx.role, peerLabel = peerLabel, inviteBlob = inviteBlob)

				is EnrollStep.Compare -> ComparePanel(
					sas = s.sas,
					peerLabel = peerLabel,
					busy = busy,
					onMatch = {
						// Mark matched up front: from here the window must survive this phone leaving, so
						// the peer can finish its side even if this confirm is slow or this phone navigates away.
						confirmed.set(true)
						busy = true
						scope.launch {
							repo.ceremony.enrollConfirm(ctx.myParty.domainId, s.exchange.peerDomainId, edgeNonce, s.exchange.peerParty.ownerSignPub)
								.onSuccess { outcome ->
									step = when (outcome) {
										is ConfirmOutcome.Linked -> EnrollStep.Done
										is ConfirmOutcome.RelayEdgeRejected ->
											EnrollStep.LinkedNoRelay(outcome.peerDomainId, s.exchange.peerParty.ownerSignPub)
									}
								}
								.onFailure { step = EnrollStep.Failed(humanizeEnrollError(it.message)) }
							busy = false
						}
					},
					onDiffer = {
						// A declined compare evicts the broker window (the dispose-cancel also fires) and
						// stops on a clear warning - never silently retried, since a mismatch may be tampering.
						busy = true
						scope.launch {
							runCatching { repo.ceremony.enrollCancel(ctx.handshakeId, ctx.role) }
							step = EnrollStep.Failed(
								"The codes did not match. Do not continue - rescan in person and try again, and if it keeps " +
									"mismatching the connection may be tampered with.",
							)
							busy = false
						}
					},
				)

				is EnrollStep.LinkedNoRelay -> LinkedNoRelayPanel(
					busy = busy,
					note = note,
					onRetry = {
						busy = true
						scope.launch {
							repo.ceremony.enrollConfirm(ctx.myParty.domainId, s.peerDomainId, edgeNonce, s.peerOwnerSignPub)
								.onSuccess { outcome ->
									step = when (outcome) {
										is ConfirmOutcome.Linked -> EnrollStep.Done
										is ConfirmOutcome.RelayEdgeRejected ->
											EnrollStep.LinkedNoRelay(outcome.peerDomainId, s.peerOwnerSignPub)
									}
								}
								.onFailure { note = humanizeEnrollError(it.message) }
							busy = false
						}
					},
					// "Later" dismisses WITHOUT marking the ceremony done: the relay edge is still
					// unauthorized, so the enrollee must keep being re-offered the retry (only a real Done
					// latches enrollCeremonyDone). onCancel just closes the overlay.
					onLater = onCancel,
				)

				is EnrollStep.Done -> DonePanel(peerLabel = peerLabel, onDone = onDone)

				is EnrollStep.Failed -> FailedPanel(reason = s.reason, onClose = onCancel)
			}
		}
	}
}

////////////////////////////////
//  Panels

@Composable
private fun WaitingPanel(role: String, peerLabel: String, inviteBlob: String?) {
	if (role == EnrollCeremony.ADMIN) {
		Text("Have $peerLabel scan this", style = MaterialTheme.typography.titleLarge)
		Text(
			"They scan it in person, then both phones show a 6-digit code to compare.",
			style = MaterialTheme.typography.bodyMedium,
		)
		if (inviteBlob != null) {
			QrCode(text = inviteBlob) {
				InfoSurface("Too large for a QR. Send the invite by Copy or Save from the previous screen.")
			}
		}
		Busy("Waiting for them to scan and confirm...")
	} else {
		Text("Confirming with $peerLabel", style = MaterialTheme.typography.titleLarge)
		Text(
			"Both phones will show a 6-digit code in a moment. Compare them together.",
			style = MaterialTheme.typography.bodyMedium,
		)
		Busy("Setting up the secure compare...")
	}
}

@Composable
private fun ComparePanel(
	sas: String,
	peerLabel: String,
	busy: Boolean,
	onMatch: () -> Unit,
	onDiffer: () -> Unit,
) {
	Text("Do the codes match?", style = MaterialTheme.typography.titleLarge)
	Text(
		"This code is on both phones. Look at $peerLabel's screen - if the two are identical, tap They match. " +
			"If they differ, stop.",
		style = MaterialTheme.typography.bodyMedium,
	)
	Surface(
		color = MaterialTheme.colorScheme.surfaceVariant,
		shape = MaterialTheme.shapes.medium,
		modifier = Modifier.fillMaxWidth(),
	) {
		Text(
			grouped(sas),
			Modifier.padding(24.dp).fillMaxWidth(),
			style = MaterialTheme.typography.displaySmall,
			textAlign = TextAlign.Center,
		)
	}
	if (busy) {
		Busy("Recording the trust...")
	} else {
		Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
			OutlinedButton(onClick = hapticClick(onDiffer), modifier = Modifier.weight(1f)) { Text("They differ") }
			Button(onClick = hapticClick(onMatch), modifier = Modifier.weight(1f)) { Text("They match") }
		}
	}
}

@Composable
private fun DonePanel(peerLabel: String, onDone: () -> Unit) {
	Text("Trusted", style = MaterialTheme.typography.titleLarge)
	InfoSurface(
		"You and $peerLabel can now share sessions with each other. Nothing is shared until you choose it from " +
			"their detail.",
	)
	Button(onClick = hapticClick(onDone), modifier = Modifier.fillMaxWidth()) { Text("Done") }
}

/** The trust edge is recorded but the Router did not authorize the relay, so cross-Domain sends
 * would be denied. Offer a one-tap retry of just the edge (idempotent), mirroring the link wizard. */
@Composable
private fun LinkedNoRelayPanel(busy: Boolean, note: String, onRetry: () -> Unit, onLater: () -> Unit) {
	Text("Trusted - finishing the connection", style = MaterialTheme.typography.titleLarge)
	Surface(
		color = MaterialTheme.colorScheme.errorContainer,
		shape = MaterialTheme.shapes.medium,
		modifier = Modifier.fillMaxWidth(),
	) {
		Text(
			"The trust is saved, but the relay between your Domains isn't authorized yet, so your agents can't " +
				"reach each other. Retry - no need to redo the scan.",
			Modifier.padding(16.dp).fillMaxWidth(),
			color = MaterialTheme.colorScheme.onErrorContainer,
			style = MaterialTheme.typography.bodyMedium,
		)
	}
	if (note.isNotEmpty()) InfoSurface(note)
	Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
		OutlinedButton(onClick = hapticClick(onLater), enabled = !busy, modifier = Modifier.weight(1f)) { Text("Later") }
		Button(onClick = hapticClick(onRetry), enabled = !busy, modifier = Modifier.weight(1f)) {
			Text(if (busy) "Retrying..." else "Retry")
		}
	}
	if (busy) Busy("Authorizing relay...")
}

@Composable
private fun FailedPanel(reason: String, onClose: () -> Unit) {
	Text("Not verified", style = MaterialTheme.typography.titleLarge)
	Surface(
		color = MaterialTheme.colorScheme.errorContainer,
		shape = MaterialTheme.shapes.medium,
		modifier = Modifier.fillMaxWidth(),
	) {
		Text(
			reason,
			Modifier.padding(16.dp).fillMaxWidth(),
			color = MaterialTheme.colorScheme.onErrorContainer,
			style = MaterialTheme.typography.bodyMedium,
		)
	}
	Button(onClick = hapticClick(onClose), modifier = Modifier.fillMaxWidth()) { Text("Close") }
}

////////////////////////////////
//  Helpers

/** Map a raw ceremony error to a calmer, actionable line. */
private fun humanizeEnrollError(message: String?): String {
	val m = message ?: "Something went wrong."
	return when {
		m.contains("too many enroll attempts", ignoreCase = true) ->
			"Too many tries on this code. Have them regenerate the invite, then rescan."
		m.contains("too many enroll handshakes", ignoreCase = true) ->
			"The server is busy with other setups. Wait a moment, then rescan."
		m.contains("did not match its commitment", ignoreCase = true) ||
			m.contains("did not match the scanned code", ignoreCase = true) ->
			"The keys did not match (possible tampering). Rescan in person and try again."
		m.contains("Timed out", ignoreCase = true) ->
			"The other phone didn't respond. Make sure you are both on this screen, then rescan."
		else -> m.take(200)
	}
}
