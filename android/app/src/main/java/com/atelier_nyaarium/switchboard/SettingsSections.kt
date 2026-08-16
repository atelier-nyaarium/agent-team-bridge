package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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

////////////////////////////////
//  Composables

/** The baked-in plugin list, one row per catalog plugin with its on/off toggle. A refused flip
 * (dep gating, broken plugin) surfaces the manager's message instead of silently reverting. */
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
				// A broken plugin cannot be switched ON, but switching OFF must stay reachable
				// (a flag stranded on by a failing boot needs a live opt-out, not a dead toggle).
				enabled = p.broken == null || p.enabled,
				onCheckedChange = { on ->
					status = plugins.setEnabled(p.id, on) ?: ""
					refresh++
					// Tell the gateway now. A session already running keeps the tools it started
					// with; this is what the NEXT session start reads.
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
	// The owner's display name (one per owner): what linked friends see them as. Owner-signed +
	// pushed to evie; it lives above the per-install device name. Seeded from state.displayName
	// (cache, refreshed from discovery) and re-seeded when that changes.
	var displayName by remember(state.displayName) { mutableStateOf(state.displayName) }
	var opStatus by remember { mutableStateOf("") }
	var opBusy by remember { mutableStateOf(false) }
	// A friend (one who first-rooted their own Domain) renaming before discovery has reported a
	// confirmed Domain id has nothing real to sign over, so evie would reject the rename ("Domain
	// not rooted" / "not owner-signed") as a raw "Could not save". Gate Save until discovery lands
	// the real Domain id. A device that never first-rooted (the admin) is not gated - its rename
	// signs over its own confirmed Domain once discovery reports it.
	val domainResolving = FriendOnboarding.renameAwaitsDiscovery(state.firstRooted, repo.confirmedDomainId())
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
	onManage: () -> Unit,
	onYourDevices: () -> Unit,
	onUsers: () -> Unit,
	onFederationScreen: () -> Unit,
) {
	// Four distinct concerns kept apart: the gateways within YOUR network, the consoles signed in to
	// your account (Your devices), linking with a friend's separate network (cross-Domain trust),
	// and the server all of that rides on. Navigation only - the forms live on their own screens,
	// since inline they read as settings of whatever section they happen to sit under.
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
}

/** Everything that is only meaningful because this console federates: which server it talks to,
 * and the owner key that server's whole trust graph roots at. */
@Composable
internal fun FederationSettings(repo: ChatRepository) {
	RouterEndpointCard(repo)
	OwnerKeysCard(repo)
	OwnerBackupCard(repo)
}

/** Point this console at a self-hosted Router. Editing here repoints the transport only: it never
 * re-runs provisioning, so the admission and enrollment latches survive. Either of the Router's
 * addresses will do: whichever one this phone can reach, the Router tells it the rest. */
@Composable
internal fun RouterEndpointCard(repo: ChatRepository) {
	val scope = rememberCoroutineScope()
	// Seed from what this console is ACTUALLY pointed at. Blank fields read as "nothing is set",
	// which is wrong on a connected console and hides the values the owner came here to check.
	val stored = remember { repo.currentRouterEndpoint(DEFAULT_ROUTER_PORT) }
	// What the Router has told this device about itself, so the owner sees the addresses in play
	// rather than only the one they typed.
	val learned = remember { RouterReach.decode(repo.store.loadRouterReach()) }
	var host by remember { mutableStateOf(stored?.host ?: "") }
	var port by remember { mutableStateOf((stored?.port ?: DEFAULT_ROUTER_PORT).toString()) }
	var certFp by remember { mutableStateOf(stored?.certFp ?: "") }
	var busy by remember { mutableStateOf(false) }

	Text("Federation Router", style = MaterialTheme.typography.titleSmall)
	Text(
		if (stored?.direct == true) "Connected directly to your own Router." else "Using the hosted relay.",
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
internal fun SecuritySettings(state: ChatState, onToggleBiometric: (Boolean) -> Unit) {
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text("Biometric lock", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
		// Enabling the lock is direct; DISABLING it is itself an owner-present action, so a grabbed
		// unlocked phone can't drop the lock (then act against the owner key) without the owner.
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
}

