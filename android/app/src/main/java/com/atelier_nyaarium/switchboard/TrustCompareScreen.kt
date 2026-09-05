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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.launch

sealed interface TrustCompareStep {
	data object Loading : TrustCompareStep

	data class Compare(val exchange: EnrollExchange) : TrustCompareStep

	data object Done : TrustCompareStep

	data class Failed(val reason: String) : TrustCompareStep
}

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
	val scope = repo.repoScope
	var step by remember { mutableStateOf<TrustCompareStep>(TrustCompareStep.Loading) }
	var busy by remember { mutableStateOf(false) }
	// Confirmation keeps the rendezvous alive after leaving the screen.
	val confirmed = remember { AtomicBoolean(false) }
	val edgeNonce = remember { repo.trust.freshLinkNonce() }
	val who = peerName.ifEmpty { "the other person" }

	LaunchedEffect(Unit) {
		repo.trust.trustExchange(rendezvousId, mySide, peerOwnerSignPub)
			.onSuccess { step = TrustCompareStep.Compare(it) }
			.onFailure { step = TrustCompareStep.Failed(it.message ?: "Trust could not complete.") }
	}
	DisposableEffect(Unit) {
		onDispose {
			if (!confirmed.get()) scope.launch { repo.trust.trustCancel(rendezvousId) }
		}
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Trust $who") },
				navigationIcon = {
					IconButton(onClick = hapticClick(onClose)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
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
							Button(onClick = hapticClick {
								confirmed.set(true)
								busy = true
								scope.launch {
									val domainId = repo.readyOrNull()?.domainId
									if (domainId == null) {
										// Reset busy state so this failure remains retryable.
										confirmed.set(false)
										busy = false
										step = TrustCompareStep.Failed("Lost the confirmed session; please retry.")
										return@launch
									}
									repo.ceremony.enrollConfirm(domainId, s.exchange.peerDomainId, edgeNonce, peerOwnerSignPub)
										// Either result records the friend edge. Relay publication is best effort.
										.onSuccess { step = TrustCompareStep.Done }
										.onFailure {
											confirmed.set(false)
											step = TrustCompareStep.Failed(it.message ?: "Could not record trust.")
										}
									busy = false
								}
							}) { Text("Yes, codes match") }
							OutlinedButton(onClick = hapticClick(onClose)) { Text("No") }
						}
					}
				}

				is TrustCompareStep.Done -> {
					InfoSurface("You and $who now trust each other.")
					Button(onClick = hapticClick(onClose), modifier = Modifier.fillMaxWidth()) { Text("Done") }
				}

				is TrustCompareStep.Failed -> {
					InfoSurface(s.reason)
					Button(onClick = hapticClick(onClose), modifier = Modifier.fillMaxWidth()) { Text("Back") }
				}
			}
		}
	}
}
