package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import kotlinx.coroutines.launch

////////////////////////////////
//  Composables

/** System settings: the device-level rows (battery, update, terminal cadence). The two Domain wipes
 * used to sit at the bottom here and live under Domain & Trust now ([DomainDangerSection]), beside
 * the things they act on. */
@Composable
internal fun SystemSettings(repo: ChatRepository) {
	var refreshText by remember { mutableStateOf((repo.sessions.terminalRefreshMs / 1000.0).toString()) }
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
				if (secs != null) repo.sessions.setTerminalRefreshMs((secs * 1000).toLong())
				// Always re-seed from the stored value: a valid entry reflects the clamp, and
				// invalid input visibly reverts to the last-saved value instead of looking saved.
				refreshText = (repo.sessions.terminalRefreshMs / 1000.0).toString()
			}) { Text("Save") }
		},
	)
	Text(
		"How often the terminal view re-captures the pane. Minimum 0.3s.",
		style = MaterialTheme.typography.bodySmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
}


/** One-press self-update: download the chosen variant's APK straight from the public
 * GitHub release, then launch the installer. The variant dropdown lets the user
 * deliberately cross-flash debug <-> release (same signing key, so it is a reinstall);
 * a same-variant pick is the normal newer-only update. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AppUpdateRow() {
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
internal fun BatteryExemptionRow() {
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
