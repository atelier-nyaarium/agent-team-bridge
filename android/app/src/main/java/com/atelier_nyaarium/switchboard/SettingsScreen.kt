package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.plugins.PluginManager
import kotlinx.coroutines.launch

////////////////////////////////
//  Composables

/** The settings hub's routes: the hub plus one focused sub-screen each. A plain enum
 * (Serializable), so App() holds the current route in rememberSaveable across rotation. */
enum class SettingsRoute { HUB, PROFILE, VOICE, NETWORKS, SECURITY, PLUGINS, SYSTEM }

private fun settingsTitle(route: SettingsRoute): String = when (route) {
	SettingsRoute.HUB -> "Settings"
	SettingsRoute.PROFILE -> "Profile"
	SettingsRoute.VOICE -> "Voice & TTS"
	SettingsRoute.NETWORKS -> "Domain & Trust"
	SettingsRoute.SECURITY -> "Security"
	SettingsRoute.PLUGINS -> "Plugins"
	SettingsRoute.SYSTEM -> "System"
}

/** Settings hub-and-spoke: the hub lists tappable category rows; each drills into a
 * focused sub-screen. Back pops a sub-screen to the hub, and the hub closes settings
 * (the App-level BackHandler mirrors this for the system back button). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
	state: ChatState,
	repo: ChatRepository,
	plugins: PluginManager,
	route: SettingsRoute,
	onRoute: (SettingsRoute) -> Unit,
	onSetDeviceName: (String) -> Unit,
	onToggleBiometric: (Boolean) -> Unit,
	onManage: () -> Unit,
	onYourDevices: () -> Unit,
	onFederation: () -> Unit,
	onClear: () -> Unit,
	onCloseSettings: () -> Unit,
) {
	// Settings opens from the pre-provision setup screen too. Before provisioning the repo is not
	// loaded, so the provisioned-only categories (Profile, Voice, Networks, Security) would NPE or
	// route into provisioned-only screens. Show ONLY the app-local sections then (System, Plugins),
	// and treat a stale saved sub-route as the hub so it can never render a provisioned-only screen
	// unprovisioned.
	val provisioned = state.provisioned
	val effectiveRoute =
		if (!provisioned && route != SettingsRoute.HUB && route != SettingsRoute.SYSTEM && route != SettingsRoute.PLUGINS) {
			SettingsRoute.HUB
		} else {
			route
		}
	val onBack = { if (effectiveRoute == SettingsRoute.HUB) onCloseSettings() else onRoute(SettingsRoute.HUB) }
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(settingsTitle(effectiveRoute)) },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			when (effectiveRoute) {
				SettingsRoute.HUB -> {
					if (provisioned) {
						SettingsRow(Icons.Default.Person, "Profile") { onRoute(SettingsRoute.PROFILE) }
						SettingsRow(Icons.Default.RecordVoiceOver, "Voice & TTS") { onRoute(SettingsRoute.VOICE) }
						SettingsRow(Icons.Default.Hub, "Domain & Trust") { onRoute(SettingsRoute.NETWORKS) }
						SettingsRow(Icons.Default.Lock, "Security") { onRoute(SettingsRoute.SECURITY) }
					}
					SettingsRow(Icons.Default.Extension, "Plugins") { onRoute(SettingsRoute.PLUGINS) }
					SettingsRow(Icons.Default.Tune, "System") { onRoute(SettingsRoute.SYSTEM) }
				}
				SettingsRoute.PROFILE -> ProfileSettings(state, repo, onSetDeviceName)
				SettingsRoute.VOICE -> SttsVoiceSection(repo)
				SettingsRoute.NETWORKS -> NetworksSettings(repo, onManage, onYourDevices, onFederation)
				SettingsRoute.SECURITY -> SecuritySettings(state, onToggleBiometric)
				SettingsRoute.PLUGINS -> PluginsSettings(plugins, repo)
				SettingsRoute.SYSTEM -> SystemSettings(repo, onClear)
			}
		}
	}
}

/** A tappable hub row: a leading category icon, the label, and a trailing drill-in chevron.
 * The icons are decorative (the label announces the row), so contentDescription is null. */
@Composable
private fun SettingsRow(icon: ImageVector, label: String, onClick: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().hapticClickable(onClick = onClick).padding(vertical = 8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(
			icon,
			contentDescription = null,
			modifier = Modifier.padding(end = 16.dp),
			tint = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Text(label, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
		Icon(Icons.Default.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
	}
}

/** The baked-in plugin list, one row per catalog plugin with its on/off toggle. A refused flip
 * (dep gating, broken plugin) surfaces the manager's message instead of silently reverting. */
@Composable
private fun PluginsSettings(plugins: PluginManager, repo: ChatRepository) {
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
private fun ProfileSettings(state: ChatState, repo: ChatRepository, onSetDeviceName: (String) -> Unit) {
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
private fun NetworksSettings(repo: ChatRepository, onManage: () -> Unit, onYourDevices: () -> Unit, onFederation: () -> Unit) {
	// Three distinct concerns kept apart: the gateways within YOUR network, the consoles signed in to
	// your account (Your devices), and linking with a friend's separate network (cross-Domain trust).
	Text("Your Domain", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onManage), modifier = Modifier.fillMaxWidth()) { Text("Gateways") }
	HorizontalDivider()
	Text("Account", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onYourDevices), modifier = Modifier.fillMaxWidth()) { Text("Your devices") }
	HorizontalDivider()
	Text("People", style = MaterialTheme.typography.titleSmall)
	Button(onClick = hapticClick(onFederation), modifier = Modifier.fillMaxWidth()) { Text("Users") }
	HorizontalDivider()
	OwnerKeysCard(repo)
	OwnerBackupCard(repo)
}

@Composable
private fun SecuritySettings(state: ChatState, onToggleBiometric: (Boolean) -> Unit) {
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text("Biometric lock", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
		// Enabling the lock is direct; DISABLING it requires a scan, so a grabbed unlocked phone can't
		// drop the lock (then act against the owner key) without the owner present. With nothing enrolled
		// promptBiometric returns true, matching the "falls back to unlocked" posture.
		Switch(
			checked = state.biometricLock,
			onCheckedChange = { wantOn ->
				if (wantOn) onToggleBiometric(true)
				else scope.launch { if (activity != null && promptBiometric(activity)) onToggleBiometric(false) }
			},
		)
	}
	Text(
		"Require fingerprint or device PIN on app open. Falls back to unlocked if nothing is enrolled.",
		style = MaterialTheme.typography.bodySmall,
	)
}

/** System settings; the danger action (Revoke and Delete Domain) sits at the bottom behind a
 * confirm, so a wipe is two levels deep (Settings -> System) plus an explicit confirmation. The
 * action purges this owner's whole Domain from the servers, so it is hidden for an admin (who
 * purges via setup.sh) and shown only to a confirmed app-only owner (see canDeleteOwnDomain). */
@Composable
private fun SystemSettings(repo: ChatRepository, onClear: () -> Unit) {
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	var confirmDelete by remember { mutableStateOf(false) }
	var deleting by remember { mutableStateOf(false) }
	var deleteError by remember { mutableStateOf<String?>(null) }
	var wipedUnconfirmed by remember { mutableStateOf(false) }
	var refreshText by remember { mutableStateOf((repo.terminalRefreshMs / 1000.0).toString()) }
	BatteryExemptionRow()
	HorizontalDivider()
	AppUpdateRow()
	HorizontalDivider()
	Text("Terminal", style = MaterialTheme.typography.titleSmall)
	OutlinedTextField(
		value = refreshText,
		onValueChange = { refreshText = it },
		label = { Text("Refresh speed (seconds)") },
		singleLine = true,
		trailingIcon = {
			TextButton(onClick = hapticClick {
				val secs = refreshText.toDoubleOrNull()
				if (secs != null) repo.setTerminalRefreshMs((secs * 1000).toLong())
				// Always re-seed from the stored value: a valid entry reflects the clamp, and
				// invalid input visibly reverts to the last-saved value instead of looking saved.
				refreshText = (repo.terminalRefreshMs / 1000.0).toString()
			}) { Text("Save") }
		},
	)
	Text(
		"How often the terminal view re-captures the pane. Minimum 0.3s.",
		style = MaterialTheme.typography.bodySmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
	// Admins purge via setup.sh; an unconfirmed Domain (offline) hides it too, so an admin whose gateway
	// is down can't read the unknown state as "not admin" and delete everything (see canDeleteOwnDomain).
	if (repo.canDeleteOwnDomain()) {
		HorizontalDivider()
		Text("Danger", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
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
					Text("- Your Domain is removed from evie", style = MaterialTheme.typography.bodySmall)
					Text("- Every gateway + device is revoked", style = MaterialTheme.typography.bodySmall)
					deleteError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
				}
			},
			confirmButton = {
				TextButton(
					enabled = !deleting,
					onClick = hapticClick {
						scope.launch {
							// Biometric-gate this destructive owner-key action, mirroring revoke/admit.
							if (repo.state.value.biometricLock && (activity == null || !promptBiometric(activity))) return@launch
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

/** Pure fold of a probe + catalog presence into the honest connection state, so a JVM
 * test pins it: Ok+voices -> CONNECTED, Ok-but-no-catalog -> NO_VOICES (a green status
 * never sits over a dimmed picker), Unreachable -> FAILED with the reason passed through. */
internal fun foldConn(probe: SttsProbe, hasVoices: Boolean): Pair<SttsConn, String> =
	when (probe) {
		is SttsProbe.Ok -> (if (hasVoices) SttsConn.CONNECTED else SttsConn.NO_VOICES) to ""
		is SttsProbe.Unreachable -> SttsConn.FAILED to probe.reason
	}

/** Voice settings for message playback: provider/voice pickers, an audible sample preview, and a
 * service liveness line. Values persist in prefs (not the credential blob) through the repository. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SttsVoiceSection(repo: ChatRepository) {
	val providers = remember { repo.sttsProviders() }
	var providerId by remember { mutableStateOf(repo.sttsProviderId) }
	val current = providers.firstOrNull { it.id == providerId }
	var voice by remember(providerId) { mutableStateOf(repo.sttsVoiceFor(providerId)) }
	var pickerOpen by remember { mutableStateOf(false) }
	var voiceMenuOpen by remember { mutableStateOf(false) }
	var sampleError by remember { mutableStateOf<String?>(null) }
	// Failed previews surface here instead of dead-ending in the log (snapshot
	// state writes are thread-safe, so the player thread can set it directly).
	DisposableEffect(Unit) {
		val errors = repo.stts.addListener { event ->
			val ended = event as? SttsPlayer.Event.Ended
			// Only the sample's own failures belong on this screen; a queue entry failing elsewhere
			// is not this preview's business.
			if (ended != null && ended.team == SttsPlayer.SAMPLE_TEAM && ended.reason != null) {
				sampleError = ended.reason
			}
		}
		onDispose { repo.stts.removeListener(errors) }
	}

	// The voice + playback controls below stay hidden until a Test confirms BOTH the service and a
	// voice catalog, so a green status can never sit over a dimmed picker. Plain remember, NOT
	// rememberSaveable: the store is the durable source, and the secret never enters the
	// saved-instance-state Bundle (a half-typed key resetting on rotation is the right trade).
	var url by remember { mutableStateOf(repo.sttsUrl) }
	var key by remember { mutableStateOf(repo.sttsKey) }
	var conn by remember { mutableStateOf(if (repo.sttsConfigured()) SttsConn.TESTING else SttsConn.NOT_SET_UP) }
	var failReason by remember { mutableStateOf("") }
	// Bumped on every creds edit / Test; a probe ignores its result once the gen moves on, so
	// an edit (or a double-tap) cannot let a stale probe revive a superseded state.
	var probeGen by remember { mutableStateOf(0) }
	val scope = rememberCoroutineScope()
	// The one generation-guarded probe: go TESTING, bump the gen, probe off the main thread, and
	// apply the result only if no newer edit/Test superseded it. Used by both the entry probe and Test.
	val runProbe = {
		conn = SttsConn.TESTING
		val gen = ++probeGen
		scope.launch {
			val (c, r) = resolveConn(repo)
			if (gen == probeGen) {
				conn = c
				failReason = r
			}
		}
	}
	LaunchedEffect(Unit) { if (repo.sttsConfigured()) runProbe() }
	// The provider dialog lives below the Connected gate; if the section collapses (creds
	// edited, or a re-Test fails), drop it so it cannot reappear unbidden on reconnect.
	LaunchedEffect(conn) { if (conn != SttsConn.CONNECTED) pickerOpen = false }

	// A creds edit demotes a resolved state to DIRTY (re-arming the Connected gate so the
	// voice/Play block hides and playback cannot use stale creds), closes the provider dialog,
	// and invalidates any in-flight probe.
	val onCredsEdit = {
		if (conn != SttsConn.NOT_SET_UP && conn != SttsConn.DIRTY) conn = SttsConn.DIRTY
		pickerOpen = false
		probeGen++
	}

	Text("Voice", style = MaterialTheme.typography.titleMedium)
	OutlinedTextField(
		value = url,
		onValueChange = {
			url = it
			onCredsEdit()
		},
		label = { Text("Service URL") },
		singleLine = true,
		modifier = Modifier.fillMaxWidth(),
	)
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedTextField(
			value = key,
			onValueChange = {
				key = it
				onCredsEdit()
			},
			label = { Text("API key") },
			singleLine = true,
			visualTransformation = PasswordVisualTransformation(),
			modifier = Modifier.weight(1f),
		)
		Button(
			enabled = conn != SttsConn.TESTING,
			onClick = hapticClick {
				// setSttsCreds is the validate+persist choke: it normalizes the URL (rejecting
				// userinfo / path / non-https that would send the key to the wrong host), stores the
				// clean origin, and returns it (null = invalid, nothing persisted).
				when {
					key.isBlank() -> conn = SttsConn.NOT_SET_UP
					else -> {
						val origin = repo.setSttsCreds(url, key)
						if (origin == null) {
							conn = SttsConn.FAILED
							failReason = "Use a valid https:// URL"
						} else {
							url = origin
							runProbe()
						}
					}
				}
			},
			modifier = Modifier.padding(start = 8.dp),
		) { Text("Test") }
	}
	Row(verticalAlignment = Alignment.CenterVertically) {
		val statusColor = when (conn) {
			SttsConn.CONNECTED -> Color(0xFF1A7F37)
			SttsConn.NO_VOICES -> Color(0xFF9A6700)
			SttsConn.FAILED -> MaterialTheme.colorScheme.error
			else -> MaterialTheme.colorScheme.onSurfaceVariant
		}
		val statusIcon = when (conn) {
			SttsConn.CONNECTED -> Icons.Default.Check
			SttsConn.NO_VOICES, SttsConn.FAILED -> Icons.Default.Warning
			else -> null
		}
		statusIcon?.let {
			Icon(it, contentDescription = null, tint = statusColor, modifier = Modifier.size(16.dp))
			Spacer(Modifier.width(4.dp))
		}
		Text(
			when (conn) {
				SttsConn.NOT_SET_UP -> "Enter your key to connect"
				SttsConn.DIRTY -> "Press Test to apply"
				SttsConn.TESTING -> "Testing..."
				SttsConn.CONNECTED -> "Connected"
				SttsConn.NO_VOICES -> "Connected, but no voices available"
				SttsConn.FAILED -> "Couldn't connect: $failReason"
			},
			style = MaterialTheme.typography.bodySmall,
			color = statusColor,
		)
	}

	// Voice + Playback unlock only when fully Connected.
	if (conn != SttsConn.CONNECTED) return
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedButton(onClick = hapticClick { pickerOpen = true }) { Text(current?.label ?: providerId.ifEmpty { "Provider" }) }
		ExposedDropdownMenuBox(
			expanded = voiceMenuOpen,
			onExpandedChange = { voiceMenuOpen = it },
			modifier = Modifier.weight(1f).padding(start = 8.dp),
		) {
			OutlinedTextField(
				value = voice,
				onValueChange = {
					voice = it
					repo.setSttsVoiceFor(providerId, it)
					// Surface the filtered matches as the user types, not just on the
					// trailing-icon tap.
					voiceMenuOpen = true
				},
				label = { Text(current?.voiceHint?.let { "$it (blank = default)" } ?: "Voice (blank = default)") },
				trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = voiceMenuOpen) },
				singleLine = true,
				modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryEditable),
			)
			// The catalog ships the provider's full voice list (hundreds for some),
			// so the field text filters the menu by id or label. A Default entry
			// clears to the provider default. The field stays editable: ElevenLabs
			// and Uberduck ship no voices, and a custom id can always be typed.
			val query = voice.trim()
			val matches = current?.voices.orEmpty().filter {
				query.isEmpty() || it.id.contains(query, ignoreCase = true) ||
					(it.label?.contains(query, ignoreCase = true) == true)
			}
			val shown = matches.take(MAX_VOICE_MENU_ITEMS)
			ExposedDropdownMenu(expanded = voiceMenuOpen, onDismissRequest = { voiceMenuOpen = false }) {
				DropdownMenuItem(
					text = { Text("Default voice") },
					onClick = hapticClick {
						voice = ""
						repo.setSttsVoiceFor(providerId, "")
						voiceMenuOpen = false
					},
				)
				for (v in shown) {
					DropdownMenuItem(
						text = {
							Column {
								Text(v.label ?: v.id)
								if (v.label != null && v.label != v.id) {
									Text(
										v.id,
										style = MaterialTheme.typography.bodySmall,
										color = MaterialTheme.colorScheme.onSurfaceVariant,
									)
								}
							}
						},
						onClick = hapticClick {
							voice = v.id
							repo.setSttsVoiceFor(providerId, v.id)
							voiceMenuOpen = false
						},
					)
				}
				if (matches.size > shown.size) {
					DropdownMenuItem(
						enabled = false,
						text = {
							Text(
								"${matches.size - shown.size} more, type to narrow",
								style = MaterialTheme.typography.bodySmall,
							)
						},
						onClick = {},
					)
				}
			}
		}
	}
	current?.note?.let {
		Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}
	Button(
		enabled = current != null,
		onClick = hapticClick {
			sampleError = null
			repo.playSttsSample()
		},
	) {
		Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
		Spacer(Modifier.width(4.dp))
		Text("Play a sample")
	}
	sampleError?.let {
		Text("Playback failed: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}

	var autoTts by remember { mutableStateOf(repo.sttsAutoGen) }
	Row(verticalAlignment = Alignment.CenterVertically) {
		Column(Modifier.weight(1f)) {
			Text("Pre-generate voice", style = MaterialTheme.typography.titleSmall)
			Text(
				"Pre-synthesize incoming messages for threads you have open, so Play is instant. Adds about 10s to the notification.",
				style = MaterialTheme.typography.bodySmall,
			)
		}
		Switch(
			checked = autoTts,
			onCheckedChange = {
				autoTts = it
				repo.sttsAutoGen = it
			},
		)
	}

	var autoPlay by remember { mutableStateOf(repo.sttsAutoPlay) }
	Column {
		Text("Auto-play new messages", style = MaterialTheme.typography.titleSmall)
		Text(
			"Speak a new message aloud the moment it arrives. Off is silent.",
			style = MaterialTheme.typography.bodySmall,
		)
		Spacer(Modifier.height(4.dp))
		val autoPlayOptions = listOf("off" to "Off", "title" to "Title", "summary" to "Summary", "full" to "Full")
		SingleChoiceSegmentedButtonRow {
			autoPlayOptions.forEachIndexed { index, (value, label) ->
				SegmentedButton(
					selected = autoPlay == value,
					onClick = hapticClick {
						autoPlay = value
						repo.sttsAutoPlay = value
					},
					shape = SegmentedButtonDefaults.itemShape(index = index, count = autoPlayOptions.size),
				) {
					Text(label)
				}
			}
		}
	}

	val chimeContext = LocalContext.current
	var chimeUri by remember { mutableStateOf(repo.sttsChimeUri) }
	// Android's own ringtone picker rather than a file picker: it already lists the sounds the user
	// has, handles the permission, and hands back a Uri.
	val chimePicker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
		if (result.resultCode == android.app.Activity.RESULT_OK) {
			val picked = result.data
				?.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI, android.net.Uri::class.java)
			// A null pick is "Silent", which is a choice rather than an absence: it must not fall back
			// to the bundled sound the way an unset preference does.
			chimeUri = picked?.toString() ?: ChatRepository.CHIME_SILENT
			// The sound is read again on every run, long after this Activity is gone, so ask to keep
			// the grant. A provider that will not persist one simply plays until it stops working,
			// which the resolver already falls back from.
			picked?.let { uri ->
				runCatching {
					chimeContext.contentResolver
						.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
				}
			}
			repo.sttsChimeUri = chimeUri
		}
	}
	Column {
		Text("Run start chime", style = MaterialTheme.typography.titleSmall)
		Text(
			when (chimeUri) {
				"" -> "The bundled chime, once at the start of an automatic run."
				ChatRepository.CHIME_SILENT -> "Silent. A run starts with the session name and no chime."
				else -> "A sound you picked, once at the start of an automatic run."
			},
			style = MaterialTheme.typography.bodySmall,
		)
		Spacer(Modifier.height(4.dp))
		Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			OutlinedButton(
				onClick = hapticClick {
					chimePicker.launch(
						Intent(RingtoneManager.ACTION_RINGTONE_PICKER).apply {
							putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION)
							putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Run start chime")
							putExtra(
								RingtoneManager.EXTRA_RINGTONE_EXISTING_URI,
								chimeUri.takeIf { it.isNotEmpty() }?.let { android.net.Uri.parse(it) },
							)
						},
					)
				},
			) {
				Text("Choose a sound")
			}
			if (chimeUri.isNotEmpty()) {
				TextButton(
					onClick = hapticClick {
						chimeUri = ""
						repo.sttsChimeUri = ""
					},
				) {
					Text("Use bundled")
				}
			}
		}
	}

	// The bubble needs a permission only an Activity can ask for, and the whole point of the bubble is
	// that the app is NOT in front. So the grant is offered here, ahead of time, rather than prompted
	// at the moment it would be useful - by which point there is no Activity to prompt from.
	var canOverlay by remember { mutableStateOf(android.provider.Settings.canDrawOverlays(chimeContext)) }
	val overlayGrant = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
		canOverlay = android.provider.Settings.canDrawOverlays(chimeContext)
	}
	// Re-read on every resume, not only on the launcher's result. This grant is revocable from system
	// settings at any time, and the launcher only ever hears about the trip it started - so a
	// revocation made anywhere else left this row claiming the bubble was on while it had stopped
	// drawing. Same treatment the battery-optimization row already gets, for the same reason.
	androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
		canOverlay = android.provider.Settings.canDrawOverlays(chimeContext)
	}
	Column {
		Text("Floating queue bubble", style = MaterialTheme.typography.titleSmall)
		Text(
			if (canOverlay) {
				"Shows what is left to speak, over other apps."
			} else {
				"Needs permission to draw over other apps. Without it the run still shows in the shade."
			},
			style = MaterialTheme.typography.bodySmall,
		)
		if (!canOverlay) {
			Spacer(Modifier.height(4.dp))
			OutlinedButton(
				// Guarded like the battery-optimization button beside it: not every build ships this
				// settings screen, and the bubble is an addition - failing to open its grant page must
				// not take the settings screen down with it.
				onClick = hapticClick {
					runCatching {
						overlayGrant.launch(
							Intent(
								android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
								android.net.Uri.parse("package:${chimeContext.packageName}"),
							),
						)
					}
				},
			) {
				Text("Allow the bubble")
			}
		}
	}

	var volume by remember { mutableStateOf(repo.sttsVolume) }
	Column {
		Text("Playback volume: $volume%", style = MaterialTheme.typography.titleSmall)
		Slider(
			value = volume.toFloat(),
			onValueChange = { volume = it.toInt() },
			onValueChangeFinished = { repo.sttsVolume = volume },
			valueRange = 0f..200f,
		)
	}

	// Its own slider rather than a share of the speech one. The chime is balanced against the voice
	// that follows it, and a tone pitched to sit under speech is usually louder than anyone wants a
	// sound they hear at the start of every run to be. Written on release, like the one above, so
	// dragging does not thrash prefs.
	var chimeVolume by remember { mutableStateOf(repo.sttsChimeVolume) }
	Column {
		Text("Chime volume: $chimeVolume%", style = MaterialTheme.typography.titleSmall)
		Slider(
			value = chimeVolume.toFloat(),
			onValueChange = { chimeVolume = it.toInt() },
			onValueChangeFinished = { repo.sttsChimeVolume = chimeVolume },
			valueRange = 0f..200f,
		)
		Text(
			"How loud the sound at the start of a run is, relative to the speech after it.",
			style = MaterialTheme.typography.bodySmall,
		)
	}

	if (pickerOpen) {
		AlertDialog(
			onDismissRequest = { pickerOpen = false },
			confirmButton = {},
			title = { Text("Provider") },
			text = {
				Column {
					for (p in providers) {
						TextButton(onClick = hapticClick {
							providerId = p.id
							repo.sttsProviderId = p.id
							voice = repo.sttsVoiceFor(p.id)
							pickerOpen = false
						}) { Text(p.label) }
					}
				}
			},
		)
	}
}

/** One-press self-update: download the chosen variant's APK straight from the public
 * GitHub release, then launch the installer. The variant dropdown lets the user
 * deliberately cross-flash debug <-> release (same signing key, so it is a reinstall);
 * a same-variant pick is the normal newer-only update. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppUpdateRow() {
	val context = LocalContext.current
	val scope = rememberCoroutineScope()
	var status by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	// Defaults to the running variant; switching it and pressing Update cross-flashes.
	var variant by remember { mutableStateOf(AppUpdater.currentVariant()) }
	var variantMenuOpen by remember { mutableStateOf(false) }
	val variants = listOf("debug", "release")
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Column(Modifier.weight(1f)) {
			Text("App update", style = MaterialTheme.typography.titleMedium)
			Text(
				"v${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		ExposedDropdownMenuBox(
			expanded = variantMenuOpen,
			onExpandedChange = { if (!busy) variantMenuOpen = it },
			modifier = Modifier.padding(end = 8.dp).widthIn(max = 130.dp),
		) {
			OutlinedTextField(
				value = variant,
				onValueChange = {},
				readOnly = true,
				enabled = !busy,
				label = { Text("Variant") },
				trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = variantMenuOpen) },
				singleLine = true,
				modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
			)
			ExposedDropdownMenu(expanded = variantMenuOpen, onDismissRequest = { variantMenuOpen = false }) {
				for (v in variants) {
					DropdownMenuItem(
						text = { Text(v) },
						onClick = hapticClick {
							variant = v
							variantMenuOpen = false
						},
					)
				}
			}
		}
		Button(
			enabled = !busy,
			onClick = hapticClick {
				busy = true
				status = "Checking for updates..."
				val chosen = variant
				scope.launch(kotlinx.coroutines.Dispatchers.IO) {
					val result = AppUpdater.downloadAndStage(context, chosen)
					kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
						when (result) {
							is AppUpdater.Result.Newer -> {
								status = "Installing v${result.versionName ?: "?"} (build ${result.versionCode})..."
								AppUpdater.install(context)
							}
							AppUpdater.Result.UpToDate -> status = "Already up to date."
							is AppUpdater.Result.Failed -> status = result.message
						}
						busy = false
					}
				}
			},
		) { Text(if (busy) "..." else "Update") }
	}
	Text(
		status.ifEmpty { "Downloads and installs the latest APK from the GitHub release." },
		style = MaterialTheme.typography.bodySmall,
	)
}

/** Deep doze cuts network even for a foreground service; screen-off delivery
 * needs the battery-optimization exemption, which a sideloaded app may simply
 * request. The state re-checks on resume (the system dialog is another activity). */
@Composable
private fun BatteryExemptionRow() {
	val context = LocalContext.current
	val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
	var exempt by remember { mutableStateOf(pm.isIgnoringBatteryOptimizations(context.packageName)) }
	androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
		exempt = pm.isIgnoringBatteryOptimizations(context.packageName)
	}
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text("Background delivery", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
		if (exempt) {
			Text("Allowed", color = MaterialTheme.colorScheme.primary)
		} else {
			Button(onClick = hapticClick {
				runCatching {
					context.startActivity(
						Intent(
							android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
							Uri.parse("package:${context.packageName}"),
						),
					)
				}
			}) { Text("Allow") }
		}
	}
	Text(
		"Exempts the app from battery optimization so messages keep arriving while the screen is off.",
		style = MaterialTheme.typography.bodySmall,
	)
}
