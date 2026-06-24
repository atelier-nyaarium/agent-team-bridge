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
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.RosterMember

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
	// One-shot fetch on entry. Null = loading; a Result carries the rows or evie's opaque reason.
	var outcome by remember { mutableStateOf<Result<List<RosterMember>>?>(null) }
	LaunchedEffect(Unit) { outcome = repo.fetchRoster() }
	val myOwner = remember { repo.ownerSignPub() }

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
						UserRow(member = m, isYou = m.ownerSignPub == myOwner)
					}
				}
			}
		}
	}
}

/** One roster row: the display name (+ a "you" tag for your own), a presence dot, and the owner
 * fingerprint (derived from the row's owner key - the long-lived identity for recognition). */
@Composable
private fun UserRow(member: RosterMember, isYou: Boolean) {
	val fingerprint = remember(member.ownerSignPub) { Crypto.fingerprint(member.ownerSignPub) }
	Card(Modifier.fillMaxWidth()) {
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
					}
				}
				Text(
					fingerprint,
					fontFamily = FontFamily.Monospace,
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			PresenceDot(online = member.online)
		}
	}
}

/** A presence dot: green online, grey offline. */
@Composable
private fun PresenceDot(online: Boolean) {
	val color = if (online) Color(0xFF2EA043) else MaterialTheme.colorScheme.outline
	Box(Modifier.size(10.dp).clip(CircleShape).background(color))
}
