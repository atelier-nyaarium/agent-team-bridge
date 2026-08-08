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
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.plugins.PluginManager

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
