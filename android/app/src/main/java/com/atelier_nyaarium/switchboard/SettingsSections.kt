package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.plugins.PluginManager
import kotlinx.coroutines.launch


@Composable
internal fun PluginsSettings(plugins: PluginManager, repo: ChatRepository) {
	val scope = rememberCoroutineScope()
	var refresh by remember { mutableStateOf(0) }
	var status by remember { mutableStateOf("") }
	val states = remember(refresh) { plugins.states() }
	if (states.isEmpty()) {
		Text(
			"No plugins ship in this build yet.",
			style = MaterialTheme.typography.bodyMedium,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}
	states.forEach { p ->
		Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
			Column(Modifier.weight(1f)) {
				Text(p.displayName, style = MaterialTheme.typography.titleMedium)
				val detail = listOf("v${p.version}", p.description).filter { it.isNotEmpty() && it != "v" }.joinToString(" - ")
				if (detail.isNotEmpty()) {
					Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
				p.broken?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
				if (p.enabled && !p.active && p.broken == null) {
					Text(
						"On, but not running: it requires a plugin that is off.",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.error,
					)
				}
			}
			Switch(
				checked = p.enabled,
				// Broken plugins remain switchable off.
				enabled = p.broken == null || p.enabled,
				onCheckedChange = { on ->
					status = plugins.setEnabled(p.id, on) ?: ""
					refresh++
					// Report changes for the next session.
					repo.command { reportEnabledPlugins() }
				},
			)
		}
	}
	if (status.isNotEmpty()) {
		Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}
}

@Composable
internal fun ProfileSettings(state: ChatState, repo: ChatRepository, onSetDeviceName: (String) -> Unit) {
	val scope = rememberCoroutineScope()
	var displayName by remember(state.displayName) { mutableStateOf(state.displayName) }
	var opStatus by remember { mutableStateOf("") }
	var opBusy by remember { mutableStateOf(false) }
	// Rename stays gated until the rooted Domain is discovered.
	val domainResolving = FriendOnboarding.renameAwaitsDiscovery(state.firstRooted, state.domainId)
	Text("Your name", style = MaterialTheme.typography.titleMedium)
	Text(
		"The name linked friends see you by.",
		style = MaterialTheme.typography.bodySmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedTextField(
			value = displayName,
			onValueChange = { displayName = it },
			singleLine = true,
			modifier = Modifier.weight(1f),
		)
		Button(
			enabled = displayName.isNotBlank() && displayName.trim() != state.displayName && !opBusy && !domainResolving,
			onClick = hapticClick {
				opBusy = true
				opStatus = ""
				scope.launch {
					repo.domainAdmin.setDisplayName(displayName)
						.onSuccess { opStatus = "Saved." }
						.onFailure { opStatus = "Couldn't save: ${it.message?.take(120)}" }
					opBusy = false
				}
			},
			modifier = Modifier.padding(start = 8.dp),
		) { Text(if (opBusy) "..." else "Save") }
	}
	if (domainResolving) {
		Text("Loading your Domain...", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	} else if (opStatus.isNotEmpty()) {
		Text(opStatus, style = MaterialTheme.typography.bodySmall)
	}

	HorizontalDivider()

	var name by remember { mutableStateOf(state.deviceName) }
	Text("Device name", style = MaterialTheme.typography.titleMedium)
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, modifier = Modifier.weight(1f))
		Button(
			enabled = name.isNotBlank() && name != state.deviceName,
			onClick = hapticClick { onSetDeviceName(name.trim()) },
			modifier = Modifier.padding(start = 8.dp),
		) { Text("Save") }
	}
}

@Composable
internal fun NetworksSettings(
	repo: ChatRepository,
	onManage: () -> Unit,
	onYourDevices: () -> Unit,
	onUsers: () -> Unit,
	onClear: () -> Unit,
	onFederationScreen: () -> Unit,
) {
	Text("Your Domain", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onManage), modifier = Modifier.fillMaxWidth()) { Text("Gateways") }
	HorizontalDivider()
	Text("Account", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onYourDevices), modifier = Modifier.fillMaxWidth()) { Text("Your devices") }
	HorizontalDivider()
	Text("People", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onUsers), modifier = Modifier.fillMaxWidth()) { Text("Users") }
	HorizontalDivider()
	Text("Infrastructure", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onFederationScreen), modifier = Modifier.fillMaxWidth()) { Text("Federation") }
	HorizontalDivider()
	DomainDangerSection(repo, onClear)
}

@Composable
internal fun DomainDangerSection(repo: ChatRepository, onClear: () -> Unit) {
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	var confirmDelete by remember { mutableStateOf(false) }
	var deleting by remember { mutableStateOf(false) }
	var deleteError by remember { mutableStateOf<String?>(null) }
	var wipedUnconfirmed by remember { mutableStateOf(false) }
	var confirmForget by remember { mutableStateOf(false) }
	var forgetting by remember { mutableStateOf(false) }
	var forgetError by remember { mutableStateOf<String?>(null) }
	Text("Danger", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
	OutlinedButton(
		onClick = hapticClick { forgetError = null; confirmForget = true },
		colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
	) {
		Icon(Icons.Default.DeleteForever, contentDescription = null, modifier = Modifier.size(18.dp))
		Spacer(Modifier.width(4.dp))
		Text("Forget this Domain")
	}
	Text(
		"Wipes this phone only. The Domain, your gateways and your other devices are untouched. Voice settings are kept.",
		style = MaterialTheme.typography.bodySmall,
	)
	if (confirmForget) {
		// Read owner-key state when confirmation opens.
		val holdsOwnerKey = remember { repo.ownerFacts.holdsOwnerKey() }
		AlertDialog(
			onDismissRequest = { if (!forgetting) confirmForget = false },
			title = { Text("Forget this Domain?") },
			text = {
				Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
					Text("This wipes the app on this phone: history, drafts, the board cache, downloaded files and the speech cache. Nothing is deleted from the Router: your Domain, gateways and other devices stay as they are.")
					if (holdsOwnerKey) {
						Text(
							"Your owner key lives on this phone, plus any backup you exported. Without a copy, nothing new can ever be owner-signed for this Domain: no admits, revokes, renames or links.",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.error,
						)
						Text(
							"Before forgetting, run Purge Federation on the Router machine, or export a backup under Federation on this screen.",
							style = MaterialTheme.typography.bodySmall,
						)
					} else {
						Text(
							"This phone does not hold the owner key, so nothing about the Domain changes. It stays listed under Your devices until removed there.",
							style = MaterialTheme.typography.bodySmall,
						)
					}
					forgetError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
				}
			},
			confirmButton = {
				TextButton(
					enabled = !forgetting,
					onClick = hapticClick {
						scope.launch {
							if (!requireOwnerPresent(repo.state.value.biometricLock, activity)) return@launch
							forgetting = true
							forgetError = null
							runCatchingCancellable { repo.domainAdmin.forgetDomain() }
								.onSuccess {
									forgetting = false
									confirmForget = false
									onClear()
								}
								.onFailure {
									forgetting = false
									forgetError = it.message ?: "Could not wipe this phone."
								}
						}
					},
				) { Text("Forget") }
			},
			dismissButton = { TextButton(enabled = !forgetting, onClick = hapticClick { confirmForget = false }) { Text("Cancel") } },
		)
	}
	if (repo.canDeleteOwnDomain()) {
		// Hide server deletion while ownership is unconfirmed.
		OutlinedButton(
			onClick = hapticClick { deleteError = null; confirmDelete = true },
			colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
		) {
			Icon(Icons.Default.DeleteForever, contentDescription = null, modifier = Modifier.size(18.dp))
			Spacer(Modifier.width(4.dp))
			Text("Revoke and Delete Domain")
		}
		Text(
			"Purges your Domain from the servers and wipes this device. Voice settings are kept.",
			style = MaterialTheme.typography.bodySmall,
		)
	}
	if (confirmDelete) {
		AlertDialog(
			onDismissRequest = { if (!deleting) confirmDelete = false },
			title = { Text("Delete your Domain?") },
			text = {
				Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
					Text("This purges your Domain from the servers, not just this phone. It can't be undone.")
					Text("- Your Domain is removed from the Router", style = MaterialTheme.typography.bodySmall)
					Text("- Every gateway + device is revoked", style = MaterialTheme.typography.bodySmall)
					deleteError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
				}
			},
			confirmButton = {
				TextButton(
					enabled = !deleting,
					onClick = hapticClick {
						scope.launch {
							if (!requireOwnerPresent(repo.state.value.biometricLock, activity)) return@launch
							deleting = true
							deleteError = null
							when (val outcome = repo.domainAdmin.deleteDomain()) {
								DeleteDomainOutcome.Deleted -> {
									confirmDelete = false
									onClear()
								}
								DeleteDomainOutcome.WipedUnconfirmed -> {
									confirmDelete = false
									wipedUnconfirmed = true
								}
								is DeleteDomainOutcome.Rejected -> {
									deleting = false
									deleteError = outcome.error
								}
							}
						}
					},
				) { Text("Delete Domain") }
			},
			dismissButton = { TextButton(enabled = !deleting, onClick = hapticClick { confirmDelete = false }) { Text("Cancel") } },
		)
	}
	if (wipedUnconfirmed) {
		AlertDialog(
			onDismissRequest = { wipedUnconfirmed = false; onClear() },
			title = { Text("Couldn't reach the servers") },
			text = { Text("This device was wiped, but we couldn't confirm the purge. Ask the admin to purge it if it survived.") },
			confirmButton = { TextButton(onClick = hapticClick { wipedUnconfirmed = false; onClear() }) { Text("OK") } },
		)
	}
}

@Composable
internal fun FederationSettings(repo: ChatRepository) {
	RouterEndpointCard(repo)
	OwnerKeysCard(repo)
	OwnerBackupCard(repo)
	ContentKeyDeliveryCard(repo)
}

@Composable
private fun ContentKeyDeliveryCard(repo: ChatRepository) {
	val scope = rememberCoroutineScope()
	var busy by remember { mutableStateOf(false) }
	var lines by remember { mutableStateOf<List<String>>(emptyList()) }
	Text("Content keys", style = MaterialTheme.typography.titleSmall)
	Button(
		enabled = !busy,
		onClick = hapticClick {
			busy = true
			scope.launch {
				try {
					lines = repo.keyDelivery.redeliverAll()
						.groupBy { it.signPub }
						.map { (member, rows) ->
							val confirmed = rows.filter { it.confirmed }.joinToString(",") { it.epoch.toString() }
							val missing = rows.filterNot { it.confirmed }.joinToString(",") { it.epoch.toString() }
							"${rows.first().kind} ${member.take(8)}: confirmed ${confirmed.ifEmpty { "none" }}; missing ${missing.ifEmpty { "none" }}"
						}
				} catch (error: Exception) {
					lines = listOf(error.message ?: error.javaClass.simpleName)
				} finally {
					busy = false
				}
			}
		},
		modifier = Modifier.fillMaxWidth(),
	) { Text("Re-deliver content keys") }
	lines.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
}

@Composable
internal fun RouterEndpointCard(repo: ChatRepository) {
	val scope = rememberCoroutineScope()
	val stored = remember { repo.currentRouterEndpoint(DEFAULT_ROUTER_PORT) }
	// Seed fields from the endpoint currently in use.
	val learned = remember { RouterReach.decode(repo.store.loadRouterReach()) }
	// Show Router addresses learned from the active reach.
	var host by remember { mutableStateOf(stored?.host ?: "") }
	var port by remember { mutableStateOf((stored?.port ?: DEFAULT_ROUTER_PORT).toString()) }
	var certFp by remember { mutableStateOf(stored?.certFp ?: "") }
	var busy by remember { mutableStateOf(false) }

	Text("Federation Router", style = MaterialTheme.typography.titleSmall)
	Text(
		if (stored?.direct == true) "Connected directly to your own Router." else "Using the hosted transport.",
		style = MaterialTheme.typography.bodySmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
	if (learned.publicHost != null || learned.lanAddresses.isNotEmpty()) {
		val parts = buildList {
			learned.publicHost?.let { add("public $it${learned.publicPort?.let { p -> ":$p" } ?: ""}") }
			if (learned.lanAddresses.isNotEmpty()) add("home ${learned.lanAddresses.joinToString(", ")}")
		}
		Text(
			"Router reachable at: ${parts.joinToString(" / ")}",
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}
	OutlinedTextField(
		value = host,
		onValueChange = { host = it },
		singleLine = true,
		label = { Text("Domain or IP") },
		supportingText = { Text("Either address works. The Router tells this phone its others.") },
		modifier = Modifier.fillMaxWidth(),
	)
	OutlinedTextField(
		value = port,
		onValueChange = { port = it.filter { c -> c.isDigit() }.take(5) },
		singleLine = true,
		label = { Text("Port") },
		modifier = Modifier.fillMaxWidth(),
	)
	OutlinedTextField(
		value = certFp,
		onValueChange = { certFp = it.trim() },
		singleLine = true,
		label = { Text("Certificate fingerprint") },
		supportingText = { Text("SHA-256, 64 hex characters. Colons are fine.") },
		modifier = Modifier.fillMaxWidth(),
	)
	Button(
		enabled = !busy && host.isNotBlank() && certFp.isNotBlank(),
		onClick = hapticClick {
			busy = true
			scope.launch {
				repo.setEndpoint(host, port.toIntOrNull() ?: DEFAULT_ROUTER_PORT, certFp)
				busy = false
			}
		},
		modifier = Modifier.fillMaxWidth(),
	) { Text(if (busy) "Saving..." else "Change Federation Router") }
	HorizontalDivider()
}

@Composable
internal fun SecuritySettings(state: ChatState, repo: ChatRepository, onToggleBiometric: (Boolean) -> Unit) {
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text("Biometric lock", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
		// Disabling the lock requires owner presence.
		Switch(
			checked = state.biometricLock,
			onCheckedChange = { wantOn ->
				if (wantOn) onToggleBiometric(true)
				else scope.launch { if (requireOwnerPresent(state.biometricLock, activity)) onToggleBiometric(false) }
			},
		)
	}
	Text(
		"Require fingerprint or device PIN on app open. Falls back to unlocked if nothing is enrolled.",
		style = MaterialTheme.typography.bodySmall,
	)
	HorizontalDivider()
	Text("Vault approvals", style = MaterialTheme.typography.titleMedium)
	var vaultUnlock by remember { mutableStateOf(repo.store.vaultUnlock) }
	val choices = listOf(
		com.atelier_nyaarium.switchboard.vault.VAULT_UNLOCK_OFF to "Off",
		com.atelier_nyaarium.switchboard.vault.VAULT_UNLOCK_EVERY to "Every approval",
		com.atelier_nyaarium.switchboard.vault.VAULT_UNLOCK_WINDOW to "30-minute unlock",
	)
	for ((value, label) in choices) {
		Row(
			Modifier.fillMaxWidth().hapticClickable {
				// Loosening the gate asks for the owner first.
				scope.launch {
					if (value != vaultUnlock && (value == com.atelier_nyaarium.switchboard.vault.VAULT_UNLOCK_EVERY ||
							requireOwnerPresent(true, activity))) {
						repo.store.vaultUnlock = value
						vaultUnlock = value
					}
				}
			},
			verticalAlignment = Alignment.CenterVertically,
		) {
			RadioButton(selected = vaultUnlock == value, onClick = null)
			Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp))
		}
	}
	Text(
		"Fingerprint or device PIN before a secret is approved or revealed. Notification buttons approve only while this is off.",
		style = MaterialTheme.typography.bodySmall,
	)
}
