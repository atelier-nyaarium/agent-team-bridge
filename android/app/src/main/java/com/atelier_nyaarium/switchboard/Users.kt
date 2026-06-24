package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.RosterMember
import kotlinx.coroutines.launch

////////////////////////////////
//  Users (the cross-tenant roster: everyone on this network)

/**
 * The Users surface: every member on this network, by name + presence. Fetched from evie
 * (ChatRepository.fetchRoster - the cross-tenant aggregation), which returns each member's owner
 * identity + display name + an online dot. This is the roster's first render: a name, a presence
 * dot, the owner fingerprint, and a "you" marker on your own row. The richer surface (the Trusted
 * badge, the per-row kebab, the arm-trust flow, share control) builds on these rows.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsersScreen(repo: ChatRepository, onBack: () -> Unit) {
	val scope = rememberCoroutineScope()
	// One-shot fetch on entry. Null = loading; a Result carries the rows or evie's opaque reason.
	var outcome by remember { mutableStateOf<Result<List<RosterMember>>?>(null) }
	val myOwner = remember { repo.ownerSignPub() }
	// Bumped on an untrust/trust so the per-row Trusted badge re-reads the friend graph.
	var trustVersion by remember { mutableIntStateOf(0) }
	// The arms aimed at me (initiatorOwnerSignPub -> rendezvousId), polled so their rows HIGHLIGHT
	// (Q2=B: no push - the target discovers the request on the roster). Refreshed on entry + on close.
	var pending by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
	// A live FLOW-2 compare (initiated by me, or me responding to a highlighted arm); overlays the roster.
	var activeTrust by remember { mutableStateOf<TrustLaunch?>(null) }

	suspend fun refresh() {
		outcome = repo.fetchRoster()
		pending = repo.fetchPendingTrust().getOrDefault(emptyList()).associate { it.initiatorOwnerSignPub to it.rendezvousId }
	}
	LaunchedEffect(Unit) { refresh() }

	val launch = activeTrust
	if (launch != null) {
		TrustCompareScreen(
			repo = repo,
			rendezvousId = launch.rendezvousId,
			mySide = launch.side,
			peerOwnerSignPub = launch.peerOwner,
			peerName = launch.peerName,
			onClose = {
				activeTrust = null
				trustVersion++
				scope.launch { refresh() }
			},
		)
		return
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Users") },
				navigationIcon = {
					IconButton(onClick = onBack) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text(
				"Everyone on your network. Names are always visible; what each person can reach stays private until shared.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			val result = outcome
			when {
				result == null -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
					CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
					Text("Loading...", style = MaterialTheme.typography.bodyMedium)
				}

				result.isFailure -> Surface(
					color = MaterialTheme.colorScheme.errorContainer,
					shape = MaterialTheme.shapes.medium,
					modifier = Modifier.fillMaxWidth(),
				) {
					Text(
						"Couldn't load the roster: ${result.exceptionOrNull()?.message?.take(140) ?: "unknown"}",
						Modifier.padding(16.dp),
						color = MaterialTheme.colorScheme.onErrorContainer,
						style = MaterialTheme.typography.bodyMedium,
					)
				}

				else -> {
					val members = result.getOrDefault(emptyList())
					if (members.isEmpty()) {
						Text("No one here yet.", style = MaterialTheme.typography.bodyMedium)
					}
					// "You" first, then the rest by name, so the roster reads consistently.
					for (m in members.sortedWith(compareByDescending<RosterMember> { it.ownerSignPub == myOwner }.thenBy { it.operatorName })) {
						val isYou = m.ownerSignPub == myOwner
						val trusted = remember(m.ownerSignPub, trustVersion) { repo.isOwnerTrusted(m.ownerSignPub) }
						val armedRendezvous = pending[m.ownerSignPub]
						UserRow(
							member = m,
							isYou = isYou,
							isTrusted = trusted,
							isPending = !isYou && !trusted && armedRendezvous != null,
							onTrust = if (!isYou && !trusted) {
								{
									// Respond to an arm aimed at me (join its rendezvous), or start a fresh one.
									activeTrust = if (armedRendezvous != null) {
										TrustLaunch(armedRendezvous, TRUST_SIDE_TARGET, m.ownerSignPub, m.operatorName)
									} else {
										TrustLaunch(repo.mintRendezvousId(), TRUST_SIDE_INITIATOR, m.ownerSignPub, m.operatorName)
									}
								}
							} else {
								null
							},
							onUntrust = if (!isYou && trusted) {
								{ scope.launch { repo.untrustOwner(m.ownerSignPub); trustVersion++ } }
							} else {
								null
							},
						)
					}
				}
			}
		}
	}
}

/** Where a tapped Trust/Respond action takes the compare flow: the rendezvous + which side I am
 * (INITIATOR when I start it, TARGET when I respond to an arm aimed at me) + the peer to confirm. */
data class TrustLaunch(val rendezvousId: String, val side: String, val peerOwner: String, val peerName: String)

/** One roster row: the display name (+ a "you" tag for your own), a Trusted badge, a presence dot,
 * the owner fingerprint (the long-lived identity for recognition), and the per-row trust controls. An
 * untrusted row shows a Trust button (Respond + a highlight when someone armed trust toward me); a
 * trusted row shows the badge + an Untrust kebab. No "not trusted" text - the missing badge conveys it. */
@Composable
private fun UserRow(
	member: RosterMember,
	isYou: Boolean,
	isTrusted: Boolean,
	isPending: Boolean,
	onTrust: (() -> Unit)?,
	onUntrust: (() -> Unit)?,
) {
	val fingerprint = remember(member.ownerSignPub) { Crypto.fingerprint(member.ownerSignPub) }
	val cardColors =
		if (isPending) CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
		else CardDefaults.cardColors()
	Card(Modifier.fillMaxWidth(), colors = cardColors) {
		Row(Modifier.padding(16.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
			Column(Modifier.weight(1f)) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Text(
						member.operatorName.ifEmpty { "(unnamed)" },
						style = MaterialTheme.typography.titleMedium,
					)
					if (isYou) {
						Spacer(Modifier.width(8.dp))
						Text("you", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
					} else if (isTrusted) {
						Spacer(Modifier.width(8.dp))
						TrustedBadge()
					}
				}
				if (isPending) {
					Text(
						"Wants to trust you",
						style = MaterialTheme.typography.labelMedium,
						color = MaterialTheme.colorScheme.onSecondaryContainer,
					)
				}
				Text(
					fingerprint,
					fontFamily = FontFamily.Monospace,
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			PresenceDot(online = member.online)
			if (onTrust != null) {
				Spacer(Modifier.width(8.dp))
				Button(onClick = onTrust) { Text(if (isPending) "Respond" else "Trust") }
			}
			if (onUntrust != null) {
				Spacer(Modifier.width(8.dp))
				RowKebab(onUntrust = onUntrust)
			}
		}
	}
}

/** The trusted-person badge: the per-row signal that you have a friend edge to this owner. */
@Composable
private fun TrustedBadge() {
	Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.small) {
		Text(
			"Trusted",
			Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSecondaryContainer,
		)
	}
}

/** The per-row overflow menu. For a trusted person it offers Untrust; Manage shares + the Trust
 * arm flow for an untrusted person are folded in as those flows land. */
@Composable
private fun RowKebab(onUntrust: () -> Unit) {
	var open by remember { mutableStateOf(false) }
	var confirm by remember { mutableStateOf(false) }
	Box {
		IconButton(onClick = { open = true }) {
			Icon(Icons.Default.MoreVert, contentDescription = "Actions")
		}
		DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
			DropdownMenuItem(
				text = { Text("Untrust") },
				onClick = {
					open = false
					confirm = true
				},
			)
		}
	}
	if (confirm) {
		ConfirmDialog(
			title = "Untrust this person?",
			body = "Removes your trust. You can trust them again later, but anything you shared with them stops being reachable.",
			confirmText = "Untrust",
			onConfirm = {
				confirm = false
				onUntrust()
			},
			onDismiss = { confirm = false },
		)
	}
}

/** A presence dot: green online, grey offline. */
@Composable
private fun PresenceDot(online: Boolean) {
	val color = if (online) Color(0xFF2EA043) else MaterialTheme.colorScheme.outline
	Box(Modifier.size(10.dp).clip(CircleShape).background(color))
}
