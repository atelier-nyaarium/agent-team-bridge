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
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

////////////////////////////////
//  Sharing (per-session audience: Private / Everyone I trust / Specific people)

private enum class ShareMode {
	PRIVATE,
	EVERYONE,
	SPECIFIC,
}

/** A snapshot of one session's current share state, derived from the gateway's share list. */
private data class SessionShares(val everyone: Boolean, val domains: Set<String>) {
	val mode: ShareMode
		get() = when {
			everyone -> ShareMode.EVERYONE
			domains.isNotEmpty() -> ShareMode.SPECIFIC
			else -> ShareMode.PRIVATE
		}
}

/**
 * The Sharing surface (the share-control mockup): your sessions + who each one reaches. Each session
 * is Private (no one), Everyone-I-trust (any trusted person, now or later), or Specific people (the
 * linked people you pick). Trust is the floor - you can only share to someone you have linked, and an
 * everyone-trusted share resolves live at the gateway, so it can never reach an unlinked Domain.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SharingScreen(repo: ChatRepository, gatewayId: String? = null, onBack: () -> Unit) {
	val scope = rememberCoroutineScope()
	val state by repo.state.collectAsState()
	val sessions = remember(state) { repo.shareableSessions().filter { gatewayId == null || it.gatewayId == gatewayId } }
	val people = remember(state) { repo.linkedDomains() }
	// Non-throwing read: a corrupt owner key degrades to empty rather than crashing the sheet.
	val myOwner = remember { repo.ownerKeysForDisplay()?.signPub.orEmpty() }
	// Roster people you have NOT linked - shown disabled ("trust first") in the Specific picker, since
	// you can only share with someone you have a cross-Domain link to.
	var trustFirst by remember { mutableStateOf<List<String>>(emptyList()) }
	// (session -> {everyone, domains}) rebuilt on each refresh from the gateway's share list.
	var shares by remember { mutableStateOf<Map<String, SessionShares>>(emptyMap()) }
	var loaded by remember { mutableStateOf(false) }
	var active by remember { mutableStateOf<String?>(null) }
	var note by remember { mutableStateOf<String?>(null) }

	suspend fun refresh() {
		val everyone = repo.sessionsSharedToEveryone().getOrDefault(emptySet())
		val specific = repo.crossDomainShares().getOrDefault(emptySet())
		val byName = sessions.associate { s ->
			s.name to SessionShares(
				everyone = s.name in everyone,
				domains = specific.filter { it.first == s.name }.map { it.second }.toSet(),
			)
		}
		shares = byName
		loaded = true
	}
	LaunchedEffect(Unit) {
		refresh()
		// People on the roster I have not linked (by owner key) become "trust first" rows.
		val linkedOwners = people.mapNotNull { it.ownerSignPub }.toSet()
		trustFirst = repo.fetchRoster().getOrDefault(emptyList())
			.filter { it.ownerSignPub != myOwner && it.ownerSignPub !in linkedOwners }
			.map { it.displayName.ifEmpty { "(unnamed)" } }
			.distinct()
	}

	val focus = active
	if (focus != null) {
		SessionShareScreen(
			sessionName = sessions.find { it.name == focus }?.let { state.label(it.name) } ?: focus,
			people = people,
			trustFirst = trustFirst,
			current = shares[focus] ?: SessionShares(false, emptySet()),
			onBack = { active = null },
			onSetMode = { mode ->
				scope.launch {
					note = null
					applyMode(repo, focus, shares[focus] ?: SessionShares(false, emptySet()), mode)
						.onFailure { note = it.message?.take(120) }
					refresh()
				}
			},
			onToggleDomain = { domainId, checked ->
				scope.launch {
					note = null
					// Specific implies not-everyone: clear the everyone share first so the two never overlap.
					if (shares[focus]?.everyone == true) repo.setShareEveryoneTrusted(focus, false)
					repo.setCrossDomainShare(focus, domainId, checked).onFailure { note = it.message?.take(120) }
					refresh()
				}
			},
		)
		return
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Sharing") },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text(
				"Pick what each session shares. Trusted people can reach what you share - nothing else.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			note?.let { InfoSurface("Couldn't update sharing: $it") }
			if (!loaded) {
				Busy("Loading sharing...")
			} else if (sessions.isEmpty()) {
				Text(
					"No shareable sessions. Only devcontainer and loose sessions can be shared.",
					style = MaterialTheme.typography.bodyMedium,
				)
			}
			for (s in sessions) {
				val st = shares[s.name] ?: SessionShares(false, emptySet())
				Card(Modifier.fillMaxWidth().hapticClickable { active = s.name }) {
					Column(Modifier.padding(16.dp)) {
						Text(state.label(s.name), style = MaterialTheme.typography.titleMedium)
						Text(
							modeSummary(st, people),
							style = MaterialTheme.typography.bodyMedium,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
				}
			}
		}
	}
}

/** One session's audience picker (the second share-control screen). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionShareScreen(
	sessionName: String,
	people: List<LinkedDomain>,
	trustFirst: List<String>,
	current: SessionShares,
	onBack: () -> Unit,
	onSetMode: (ShareMode) -> Unit,
	onToggleDomain: (String, Boolean) -> Unit,
) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(sessionName) },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(8.dp),
		) {
			Text("Who can reach this session?", style = MaterialTheme.typography.titleMedium)
			Text(
				"Your agents stay yours. This only lets a trusted person's agents collaborate on this one session.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			ModeRow("Private", "No one but you.", current.mode == ShareMode.PRIVATE) { onSetMode(ShareMode.PRIVATE) }
			ModeRow("Everyone I trust", "Anyone you trust now or later.", current.mode == ShareMode.EVERYONE) {
				onSetMode(ShareMode.EVERYONE)
			}
			ModeRow("Specific people", "Only the people you pick.", current.mode == ShareMode.SPECIFIC) {
				onSetMode(ShareMode.SPECIFIC)
			}
			if (current.mode == ShareMode.SPECIFIC) {
				HorizontalDivider(Modifier.padding(vertical = 8.dp))
				if (people.isEmpty()) {
					Text(
						"No linked people yet. Trust someone first, then you can share with them.",
						style = MaterialTheme.typography.bodyMedium,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				for (p in people) {
					Row(
						Modifier.fillMaxWidth().hapticClickable {
							onToggleDomain(p.domainId, p.domainId !in current.domains)
						}.padding(vertical = 4.dp),
						verticalAlignment = Alignment.CenterVertically,
					) {
						Checkbox(
							checked = p.domainId in current.domains,
							onCheckedChange = { onToggleDomain(p.domainId, it) },
						)
						Text(p.displayName ?: p.domainId, Modifier.padding(start = 4.dp))
					}
				}
				// People you have not linked: shown disabled, since sharing needs a trust link first.
				for (name in trustFirst) {
					Row(
						Modifier.fillMaxWidth().padding(vertical = 4.dp),
						verticalAlignment = Alignment.CenterVertically,
					) {
						Checkbox(checked = false, enabled = false, onCheckedChange = null)
						Text(name, Modifier.padding(start = 4.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
						Text(
							"  trust first",
							style = MaterialTheme.typography.labelSmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
				}
			}
		}
	}
}

@Composable
private fun ModeRow(title: String, subtitle: String, selected: Boolean, onSelect: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().hapticClickable(onClick = onSelect).padding(vertical = 4.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		RadioButton(selected = selected, onClick = onSelect)
		Column(Modifier.padding(start = 4.dp)) {
			Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = if (selected) FontWeight.SemiBold else null)
			Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

/** A one-line summary of a session's current audience, for the list row. */
private fun modeSummary(st: SessionShares, people: List<LinkedDomain>): String =
	when (st.mode) {
		ShareMode.PRIVATE -> "Private"
		ShareMode.EVERYONE -> "Everyone I trust"
		ShareMode.SPECIFIC -> {
			val names = st.domains.map { d -> people.find { it.domainId == d }?.displayName ?: d }
			when {
				names.size == 1 -> "${names.first()} only"
				else -> "${names.size} people"
			}
		}
	}

/** Apply a top-level mode change (the radio rows). Specific is entered by then picking people, so it
 * only clears the everyone share here; Private clears both, Everyone sets everyone + clears specifics. */
private suspend fun applyMode(
	repo: ChatRepository,
	session: String,
	current: SessionShares,
	mode: ShareMode,
): Result<Unit> = runCatching {
	when (mode) {
		ShareMode.PRIVATE -> {
			if (current.everyone) repo.setShareEveryoneTrusted(session, false).getOrThrow()
			for (d in current.domains) repo.setCrossDomainShare(session, d, false).getOrThrow()
		}

		ShareMode.EVERYONE -> {
			// Everyone supersedes specific shares; clear them so the two never overlap.
			for (d in current.domains) repo.setCrossDomainShare(session, d, false).getOrThrow()
			repo.setShareEveryoneTrusted(session, true).getOrThrow()
		}

		ShareMode.SPECIFIC -> {
			// Leaving everyone for specific: drop everyone; the people checklist adds the specifics.
			if (current.everyone) repo.setShareEveryoneTrusted(session, false).getOrThrow()
		}
	}
}
