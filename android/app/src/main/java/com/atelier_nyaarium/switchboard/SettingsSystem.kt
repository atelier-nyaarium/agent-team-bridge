package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DeleteForever
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.launch

////////////////////////////////
//  Composables

/** System settings; the danger action (Revoke and Delete Domain) sits at the bottom behind a
 * confirm, so a wipe is two levels deep (Settings -> System) plus an explicit confirmation. The
 * action purges this owner's whole Domain from the servers, so it is hidden for an admin (who
 * purges via setup.sh) and shown only to a confirmed app-only owner (see canDeleteOwnDomain). */
@Composable
internal fun SystemSettings(repo: ChatRepository, onClear: () -> Unit) {
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
