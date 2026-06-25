package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.launch

////////////////////////////////
//  FLOW-2 trust compare (the roster-initiated user-to-user 6-digit compare)

/** The product step for the FLOW-2 compare UI. */
sealed interface TrustCompareStep {
	/** Running the commit-reveal exchange (waiting for the other person to arm/join + reveal). */
	data object Loading : TrustCompareStep

	/** Both sides revealed; the humans compare the typed 6-digit code over a side channel. */
	data class Compare(val exchange: EnrollExchange) : TrustCompareStep

	/** Trust recorded (the friend edge is written; the relay edge is best-effort). */
	data object Done : TrustCompareStep

	/** A terminal failure (mismatch, timeout, transport, or a decline). */
	data class Failed(val reason: String) : TrustCompareStep
}

/**
 * The FLOW-2 trust compare: drives `ChatRepository.trustExchange` over a rendezvous (the initiator
 * armed; the target joined a highlighted arm), shows the typed 6-digit SAS for an out-of-band
 * compare, and on a mutual [Yes] records the owner-to-owner trust (REUSES `enrollConfirm`). The SAS
 * code is owner-anchored + symmetric (sorted-owner-key roles), so both phones display the SAME code.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrustCompareScreen(
	repo: ChatRepository,
	rendezvousId: String,
	mySide: String,
	peerOwnerSignPub: String,
	peerName: String,
	onClose: () -> Unit,
) {
	val scope = rememberCoroutineScope()
	var step by remember { mutableStateOf<TrustCompareStep>(TrustCompareStep.Loading) }
	var busy by remember { mutableStateOf(false) }
	// Set once the human commits trust, so leaving the screen afterward does NOT cancel the rendezvous.
	val confirmed = remember { AtomicBoolean(false) }
	val edgeNonce = remember { repo.freshLinkNonce() }
	val who = peerName.ifEmpty { "the other person" }

	LaunchedEffect(Unit) {
		repo.trustExchange(rendezvousId, mySide, peerOwnerSignPub)
			.onSuccess { step = TrustCompareStep.Compare(it) }
			.onFailure { step = TrustCompareStep.Failed(it.message ?: "Trust could not complete.") }
	}
	DisposableEffect(Unit) {
		onDispose {
			if (!confirmed.get()) scope.launch { repo.trustCancel(rendezvousId) }
		}
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Trust $who") },
				navigationIcon = {
					IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize(),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			when (val s = step) {
				is TrustCompareStep.Loading -> Busy("Waiting for $who to respond...")

				is TrustCompareStep.Compare -> {
					InfoSurface("Read this code to $who (call or message them). Tap Yes only if they see the SAME code.")
					Text(
						grouped(s.exchange.sas),
						style = MaterialTheme.typography.displaySmall,
						fontFamily = FontFamily.Monospace,
					)
					if (busy) {
						Busy("Recording trust...")
					} else {
						Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
							Button(onClick = {
								confirmed.set(true)
								busy = true
								scope.launch {
									repo.enrollConfirm(
										repo.confirmedDomainId() ?: return@launch,
										s.exchange.peerDomainId,
										edgeNonce,
										peerOwnerSignPub,
									)
										// Both outcomes mean the friend edge is recorded (the relay edge is
										// best-effort); the Trusted badge appears either way.
										.onSuccess { step = TrustCompareStep.Done }
										.onFailure {
											confirmed.set(false)
											step = TrustCompareStep.Failed(it.message ?: "Could not record trust.")
										}
									busy = false
								}
							}) { Text("Yes, codes match") }
							OutlinedButton(onClick = onClose) { Text("No") }
						}
					}
				}

				is TrustCompareStep.Done -> {
					InfoSurface("You and $who now trust each other.")
					Button(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Done") }
				}

				is TrustCompareStep.Failed -> {
					InfoSurface(s.reason)
					Button(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Back") }
				}
			}
		}
	}
}
