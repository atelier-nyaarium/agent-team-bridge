package com.atelier_nyaarium.switchboard.vault

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.StatusChip
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.VaultGrant
import kotlinx.coroutines.launch

/** Pending requests, the entry list, and the grants a session holds. */
@Composable
fun VaultScreen(
	repo: ChatRepository,
	state: ChatState,
	onOpenEntry: (String?) -> Unit,
	onOpenRequest: (String) -> Unit,
	modifier: Modifier = Modifier,
) {
	LaunchedEffect(Unit) {
		repo.vaultOps.refresh()
		repo.vaultOps.refreshGrants()
	}
	val revision by repo.vault.revision
	val pending by repo.vault.pending.collectAsState()
	val grants by repo.vault.grants
	var query by rememberSaveable { mutableStateOf("") }
	val views = remember(revision) { repo.vaultOps.views() }
	val shown = remember(views, query) {
		val q = query.trim()
		views.filter { q.isEmpty() || it.matches(q) }.sortedBy { it.title.lowercase() }
	}
	val scope = rememberCoroutineScope()

	LazyColumn(
		modifier = modifier.fillMaxSize().padding(horizontal = 12.dp),
		verticalArrangement = Arrangement.spacedBy(10.dp),
	) {
		if (pending.isNotEmpty()) {
			item(key = "sect:requests") { SectionLabel("Requests") }
			for (request in pending) {
				item(key = "request:${request.requestId}") {
					val entryTitle = request.entryId?.let { id -> views.firstOrNull { it.id == id }?.title }
					RequestCard(state, request, entryTitle) { onOpenRequest(request.requestId) }
				}
			}
		}
		item(key = "sect:entries") {
			Row(
				Modifier.fillMaxWidth().padding(top = 6.dp),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				OutlinedTextField(
					value = query,
					onValueChange = { query = it },
					singleLine = true,
					label = { Text("Search") },
					modifier = Modifier.weight(1f),
				)
				Button(
					onClick = hapticClick { onOpenEntry(null) },
					contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
					modifier = Modifier.height(34.dp),
				) {
					Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
					Spacer(Modifier.width(5.dp))
					Text("New", style = MaterialTheme.typography.labelLarge)
				}
			}
		}
		if (shown.isEmpty()) {
			item(key = "sect:empty") {
				Text(
					if (views.isEmpty()) "Nothing stored. New adds a secret or a note." else "No entry matches.",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
				)
			}
		}
		for (entry in shown) {
			item(key = "entry:${entry.id}") {
				EntryRow(entry) { onOpenEntry(entry.id) }
			}
		}
		val held = grants.entries.flatMap { (gatewayId, list) -> list.map { gatewayId to it } }
		if (held.isNotEmpty()) {
			item(key = "sect:grants") { SectionLabel("Grants") }
			for ((gatewayId, grant) in held) {
				item(key = "grant:$gatewayId:${grant.grantId}") {
					GrantRow(state, gatewayId, grant, views) {
						scope.launch { repo.vaultOps.revoke(gatewayId, grant.grantId) }
					}
				}
			}
		}
		item(key = "sect:bottom") { Spacer(Modifier.height(16.dp)) }
	}
}

@Composable
private fun RequestCard(state: ChatState, request: VaultPendingRequest, entryTitle: String?, onClick: () -> Unit) {
	val expiry = expiresIn(request.deadlineAt)
	Card(Modifier.fillMaxWidth().clickable(onClick = hapticClick(onClick))) {
		Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
			Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
				Text(requestTitle(request, entryTitle), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
				Text(
					expiry.text,
					style = MaterialTheme.typography.labelSmall,
					color = if (expiry.urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			Text(requester(state, request), style = MaterialTheme.typography.bodySmall)
			Text(
				request.operation,
				style = MaterialTheme.typography.bodySmall,
				fontFamily = FontFamily.Monospace,
				maxLines = 2,
				overflow = TextOverflow.Ellipsis,
			)
		}
	}
}

@Composable
private fun EntryRow(entry: VaultEntryView, onClick: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onClick)).padding(vertical = 8.dp),
		horizontalArrangement = Arrangement.spacedBy(8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(entry.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
			entry.description?.let {
				Text(
					it,
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
				)
			}
		}
		if (!entry.hasValue) StatusChip("note", MaterialTheme.colorScheme.outline)
		if (entry.createdBy == "gateway") StatusChip("captured", MaterialTheme.colorScheme.secondary)
		entry.gateways?.let { StatusChip("${it.size} gateway${if (it.size == 1) "" else "s"}", MaterialTheme.colorScheme.tertiary) }
		if (entry.gatewaysUnreadable) StatusChip("scope unreadable", MaterialTheme.colorScheme.error)
	}
}

@Composable
private fun GrantRow(
	state: ChatState,
	gatewayId: String,
	grant: VaultGrant,
	views: List<VaultEntryView>,
	onRevoke: () -> Unit,
) {
	val entryTitle = grant.entryId?.let { id -> views.firstOrNull { it.id == id }?.title ?: id }
	Row(
		Modifier.fillMaxWidth().padding(vertical = 4.dp),
		horizontalArrangement = Arrangement.spacedBy(8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(
				"${sessionName(state, gatewayId, grant.sessionTarget)} on $gatewayId",
				style = MaterialTheme.typography.bodyMedium,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
			)
			Text(
				listOfNotNull(
					if (grant.tier == VAULT_DECISION_SESSION) "This session" else "30 minutes",
					entryTitle,
					grant.shape,
					grant.expiresAt?.let { expiresIn(it).text },
				).joinToString(" - "),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				maxLines = 2,
				overflow = TextOverflow.Ellipsis,
			)
		}
		TextButton(onClick = hapticClick(onRevoke)) { Text("Revoke") }
	}
}

/** The session's label when this phone knows it, else the gateway's own name for it. */
private fun sessionName(state: ChatState, gatewayId: String, sessionTarget: String): String {
	if (sessionTarget.startsWith("helper.")) return "Askpass helper"
	val team = state.teams.firstOrNull { it.gatewayId == gatewayId && it.shortName == sessionTarget }
	return team?.let { state.label(it.name) } ?: sessionTarget
}

@Composable
private fun SectionLabel(text: String) {
	Text(
		text,
		style = MaterialTheme.typography.labelMedium,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
		modifier = Modifier.padding(top = 10.dp),
	)
}
