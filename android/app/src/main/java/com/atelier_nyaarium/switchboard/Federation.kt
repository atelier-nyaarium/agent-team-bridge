package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import kotlinx.coroutines.launch

////////////////////////////////
//  Federation home (Settings -> Networks & Trust -> Federation)

/**
 * The cross-Domain trust hub. Two concerns kept visibly separate so cross-network access is
 * never granted by accident: MY NETWORK (this owner's own identity), and PEERS (friend
 * networks this owner has LINKED, the only networks any agent can reach). A Peer row drills
 * into its detail (share controls + unlink); the Link button opens the both-present pairing.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FederationScreen(
	repo: ChatRepository,
	onBack: () -> Unit,
	onLink: () -> Unit,
	onPeer: (String) -> Unit,
	onHostNetworks: () -> Unit,
) {
	// Observe the chat state so a discovery change or an unlink re-derives the peer list. The PEERS
	// roster unions the gateway's cross-Domain peer set (state.linkedPeerDomains) with discovery, so
	// the remember key tracks BOTH: a freshly-linked peer with no discovery sessions still appears.
	val state by repo.state.collectAsState()
	val peers = remember(state.teams, state.linkedPeerDomains) { repo.linkedDomains() }
	val myName = state.operatorName.ifEmpty { repo.localDomainId() }
	val ownerFp = remember { repo.ownerSas() }
	// Operator-only gate for the GUEST NETWORKS section: only the home Domain owner can host guests.
	val isOperator = remember(state.teams) { repo.isHomeOperator() }

	// Pull the cross-Domain peer roster on entry so a peer just linked in another screen is listed
	// immediately, without waiting for the next periodic board refresh. Best-effort (see the repo).
	LaunchedEffect(Unit) { repo.refreshLinkedPeers() }

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Federation") },
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
			verticalArrangement = Arrangement.spacedBy(20.dp),
		) {
			Text(
				"Link with a friend's network so your agents can collaborate. Nothing is shared until you choose a session.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)

			SectionLabel("MY NETWORK")
			Card(Modifier.fillMaxWidth()) {
				Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
					Text(myName, style = MaterialTheme.typography.titleMedium)
					Text("Owner fingerprint", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
					Text(ownerFp, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
				}
			}

			// Hosting != linking: a separate section for guest networks YOU run for friends. Lives
			// apart from PEERS so cross-network access is never granted by simply hosting someone.
			// Operator-only: provision_tenant is gated on the home operator key, so a friend (a non-home
			// Domain) would only get an error-bounce here. Hide the section rather than show a dead button.
			if (isOperator) {
				SectionLabel("GUEST NETWORKS")
				Text(
					"Set up a network for a friend who has none. They get a one-time invite and run their own agents on their own computer.",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				Button(onClick = onHostNetworks, modifier = Modifier.fillMaxWidth()) { Text("Guest networks") }
			}

			SectionLabel("PEERS")
			Text(
				"Networks you've linked. Tap one to choose what's shared.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			if (peers.isEmpty()) {
				Text(
					"No peers yet. Tap Link with a peer below (both phones on this screen).",
					style = MaterialTheme.typography.bodyMedium,
				)
			}
			for (peer in peers) {
				PeerRow(peer = peer, onClick = { onPeer(peer.domainId) })
			}

			Button(onClick = onLink, modifier = Modifier.fillMaxWidth()) { Text("Link with a peer") }
		}
	}
}

/** One linked-peer row: the friend's network NAME (their propagated operator name) when known,
 * falling back to the opaque Domain id, a presence dot, the session count, and a drill-in chevron. */
@Composable
private fun PeerRow(peer: LinkedDomain, onClick: () -> Unit) {
	Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
		Row(
			Modifier.padding(16.dp).fillMaxWidth(),
			verticalAlignment = Alignment.CenterVertically,
		) {
			PresenceDot(peer.online)
			Spacer(Modifier.width(12.dp))
			Column(Modifier.weight(1f)) {
				Text(peer.operatorName ?: peer.domainId, style = MaterialTheme.typography.titleMedium)
				Text(
					if (peer.online) "${peer.sessionCount} shared sessions" else "offline",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			Icon(Icons.Default.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

////////////////////////////////
//  Peer detail (share controls + unlink)

/**
 * A linked peer's detail: pick which of THEIR shared sessions my agents may reach (the slimmed
 * discovery list), toggle which of MY local sessions are shared to them (the checkmark IS the
 * consent, no double-confirm), and Unlink. Sharing is two-directional and lives here so both
 * sides are managed in one place.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PeerDetailScreen(repo: ChatRepository, domainId: String, onBack: () -> Unit, onUnlinked: () -> Unit) {
	val scope = rememberCoroutineScope()
	val state by repo.state.collectAsState()
	val theirSessions = remember(state.teams, domainId) { repo.peerSessions(domainId) }
	val mySessions = remember(state.teams) { repo.shareableSessions() }
	// The friend's network NAME (their propagated operator name) when a shared session carries it,
	// else the opaque Domain id. Used in the title + body so the human sees "Carol", not a hex slug.
	val peerName = theirSessions.firstNotNullOfOrNull { it.operatorName?.ifEmpty { null } } ?: domainId
	// My current shares to this Domain, loaded async (the gateway holds the share state).
	var myShares by remember { mutableStateOf<Set<String>>(emptySet()) }
	var status by remember { mutableStateOf("") }
	var confirmUnlink by remember { mutableStateOf(false) }
	var busy by remember { mutableStateOf(false) }

	androidx.compose.runtime.LaunchedEffect(domainId) {
		repo.crossDomainShares()
			.onSuccess { pairs -> myShares = pairs.filter { it.second == domainId }.map { it.first }.toSet() }
			.onFailure { status = "Could not load shares: ${it.message?.take(120)}" }
	}

	if (confirmUnlink) {
		ConfirmDialog(
			title = "Unlink $peerName?",
			body = "$peerName loses access immediately. You can re-link later (both phones on the Link screen).",
			confirmText = "Unlink",
			onConfirm = {
				confirmUnlink = false
				busy = true
				scope.launch {
					repo.unlinkDomain(domainId)
						.onSuccess { onUnlinked() }
						.onFailure {
							busy = false
							status = "Unlink failed: ${it.message?.take(120)}"
						}
				}
			},
			onDismiss = { confirmUnlink = false },
		)
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(peerName) },
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
			verticalArrangement = Arrangement.spacedBy(20.dp),
		) {
			if (status.isNotEmpty()) {
				Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.medium) {
					Text(
						status,
						Modifier.padding(12.dp).fillMaxWidth(),
						color = MaterialTheme.colorScheme.onErrorContainer,
						style = MaterialTheme.typography.bodySmall,
					)
				}
			}

			SectionLabel("SHARED WITH YOU")
			Text(
				"Sessions $peerName shared to you. Your agents can reach these.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			if (theirSessions.isEmpty()) {
				Text("$peerName hasn't shared any sessions yet.", style = MaterialTheme.typography.bodyMedium)
			}
			for (s in theirSessions) {
				Card(Modifier.fillMaxWidth()) {
					Row(Modifier.padding(16.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
						PresenceDot(s.status == "online")
						Spacer(Modifier.width(12.dp))
						Column(Modifier.weight(1f)) {
							Text(s.displayName, style = MaterialTheme.typography.titleMedium)
							Text(s.kind, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
						}
					}
				}
			}

			HorizontalDivider()

			SectionLabel("YOU SHARE WITH $peerName")
			Text(
				"Check a session to share it with $peerName. Their agents can reach it immediately - no second confirmation.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			if (mySessions.isEmpty()) {
				Text(
					"No shareable sessions. Only devcontainer and loose sessions can be shared.",
					style = MaterialTheme.typography.bodyMedium,
				)
			}
			for (s in mySessions) {
				val target = s.name
				val shared = target in myShares
				ShareRow(
					label = s.displayName,
					sublabel = s.kind,
					checked = shared,
					enabled = !busy,
					onToggle = {
						val next = !shared
						// Optimistic flip, reverted on failure, so the checkmark reflects the request.
						myShares = if (next) myShares + target else myShares - target
						scope.launch {
							repo.setCrossDomainShare(target, domainId, next).onFailure {
								myShares = if (next) myShares - target else myShares + target
								status = "Share change failed: ${it.message?.take(120)}"
							}
						}
					},
				)
			}

			HorizontalDivider()
			OutlinedButton(
				onClick = { confirmUnlink = true },
				enabled = !busy,
				modifier = Modifier.fillMaxWidth(),
			) { Text("Unlink $peerName", color = MaterialTheme.colorScheme.error) }
		}
	}
}

/** A session share row: the session name + kind on the left, a checkbox-style toggle on the
 * right. Tapping the whole row toggles, so the target is forgiving on a phone. */
@Composable
private fun ShareRow(label: String, sublabel: String, checked: Boolean, enabled: Boolean, onToggle: () -> Unit) {
	Card(Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onToggle)) {
		Row(Modifier.padding(16.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
			Column(Modifier.weight(1f)) {
				Text(label, style = MaterialTheme.typography.titleMedium)
				Text(sublabel, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
			ShareCheck(checked)
		}
	}
}

/** The shared/unshared glyph: a filled check in a tinted circle when shared, a hollow ring when
 * not. The contentDescription announces the state (the icon itself is decorative). */
@Composable
private fun ShareCheck(checked: Boolean) {
	if (checked) {
		Box(
			Modifier.size(28.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
			contentAlignment = Alignment.Center,
		) {
			Icon(
				Icons.Default.Check,
				contentDescription = "shared",
				tint = MaterialTheme.colorScheme.onPrimary,
				modifier = Modifier.size(18.dp),
			)
		}
	} else {
		// A hollow ring: a tinted disc with a surface-colored center punched out.
		Box(
			Modifier.size(28.dp).clip(CircleShape).background(MaterialTheme.colorScheme.outline),
			contentAlignment = Alignment.Center,
		) {
			Box(Modifier.size(22.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surface))
		}
	}
}

////////////////////////////////
//  Shared bits

@Composable
private fun PresenceDot(online: Boolean) {
	val color = if (online) Color(0xFF2E7D32) else MaterialTheme.colorScheme.outline
	Box(Modifier.size(10.dp).clip(CircleShape).background(color))
}

/** A monospace, large, easy-to-read code block (the listening token / the SAS), the focal point
 * of each pairing step. */
@Composable
internal fun CodeBlock(code: String) {
	Surface(
		color = MaterialTheme.colorScheme.surfaceVariant,
		shape = MaterialTheme.shapes.medium,
		modifier = Modifier.fillMaxWidth(),
	) {
		Text(
			code,
			Modifier.padding(16.dp).fillMaxWidth(),
			fontFamily = FontFamily.Monospace,
			style = MaterialTheme.typography.headlineSmall,
			textAlign = TextAlign.Center,
		)
	}
}
