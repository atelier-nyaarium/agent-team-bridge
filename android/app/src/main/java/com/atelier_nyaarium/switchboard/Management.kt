package com.atelier_nyaarium.switchboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.crypto.Crypto
import kotlinx.coroutines.launch

/** Copy a value to the clipboard under a short label. */
private fun copyToClipboard(context: Context, label: String, value: String) {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
	cm.setPrimaryClip(ClipData.newPlainText(label, value))
}

/** Hand text to the system share sheet, so the owner can save it to a file, a password
 * manager, or a QR app - rather than leaving a secret on the clipboard for any app to read. */
private fun shareText(context: Context, subject: String, value: String) {
	val intent = Intent(Intent.ACTION_SEND).apply {
		type = "text/plain"
		putExtra(Intent.EXTRA_SUBJECT, subject)
		putExtra(Intent.EXTRA_TEXT, value)
	}
	context.startActivity(Intent.createChooser(intent, subject))
}

/** The owner key + fingerprint, shown under settings so the owner can re-copy it for a host
 * setup re-run. Reading it mints-or-loads the owner identity on first call. */
@Composable
fun OwnerKeysCard(repo: ChatRepository) {
	val context = LocalContext.current
	// Non-throwing: a corrupt owner key returns null so the card shows a restore prompt instead
	// of crashing settings. An absent key still mints (the silent first-gen).
	val keys = remember { repo.ownerKeysForDisplay() }
	Card(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Text("Owner key", style = MaterialTheme.typography.titleMedium)
			if (keys == null) {
				Text(
					"Your owner key could not be read. Restore it from a backup below, or recover the Domain.",
					style = MaterialTheme.typography.bodySmall,
				)
			} else {
				Text(
					"The key your Domain trusts. Copy it if you re-run setup.",
					style = MaterialTheme.typography.bodySmall,
				)
				Text("Fingerprint: ${keys.sas}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
				// Both owner pubkeys as one JSON blob; setup.sh parses it. base64 needs no escaping.
				OutlinedButton(
					onClick = { copyToClipboard(context, "owner key", """{"signPub":"${keys.signPub}","boxPub":"${keys.boxPub}"}""") },
					modifier = Modifier.fillMaxWidth(),
				) { Text("Copy key") }
			}
		}
	}
}

/** Owner-key backup: export a passphrase-encrypted blob to store offline, or restore the
 * owner key on a fresh install. The owner key is the one artifact worth safeguarding. */
@Composable
fun OwnerBackupCard(repo: ChatRepository) {
	val context = LocalContext.current
	val scope = rememberCoroutineScope()
	var pass1 by remember { mutableStateOf("") }
	var pass2 by remember { mutableStateOf("") }
	var restoreBlob by remember { mutableStateOf("") }
	var restorePass by remember { mutableStateOf("") }
	var status by remember { mutableStateOf("") }
	Card(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Text("Owner key backup", style = MaterialTheme.typography.titleMedium)
			Text(
				"Export a passphrase-encrypted backup and keep it offline. Anyone with the file and " +
					"the passphrase controls your Domain, so pick a strong one.",
				style = MaterialTheme.typography.bodySmall,
			)
			OutlinedTextField(
				value = pass1,
				onValueChange = { pass1 = it },
				label = { Text("Passphrase (min 8)") },
				visualTransformation = PasswordVisualTransformation(),
				modifier = Modifier.fillMaxWidth(),
			)
			OutlinedTextField(
				value = pass2,
				onValueChange = { pass2 = it },
				label = { Text("Confirm passphrase") },
				visualTransformation = PasswordVisualTransformation(),
				modifier = Modifier.fillMaxWidth(),
			)
			Button(
				enabled = pass1.length >= 8 && pass1 == pass2,
				onClick = {
					status = ""
					scope.launch {
						val blob = repo.exportOwnerBackup(pass1)
						shareText(context, "Switchboard owner key backup", blob)
						status = "Saved. Keep it offline."
					}
				},
				modifier = Modifier.fillMaxWidth(),
			) { Text("Export backup") }

			HorizontalDivider()
			Text("Restore on a fresh install", style = MaterialTheme.typography.titleSmall)
			OutlinedTextField(
				value = restoreBlob,
				onValueChange = { restoreBlob = it },
				label = { Text("Backup text") },
				modifier = Modifier.fillMaxWidth(),
			)
			OutlinedTextField(
				value = restorePass,
				onValueChange = { restorePass = it },
				label = { Text("Passphrase") },
				visualTransformation = PasswordVisualTransformation(),
				modifier = Modifier.fillMaxWidth(),
			)
			Button(
				enabled = restoreBlob.isNotBlank() && restorePass.isNotBlank(),
				onClick = {
					status = ""
					scope.launch {
						status = when (repo.importOwnerBackup(restoreBlob.trim(), restorePass)) {
							OwnerRestoreResult.OK -> "Owner key restored."
							OwnerRestoreResult.DIFFERENT_OWNER ->
								"That backup is a different owner key. Only restore it on a fresh device."
							OwnerRestoreResult.WRONG_PASSPHRASE -> "Restore failed (wrong passphrase or bad file)."
						}
					}
				},
				modifier = Modifier.fillMaxWidth(),
			) { Text("Restore owner key") }
			if (status.isNotEmpty()) Text(status, style = MaterialTheme.typography.bodySmall)
		}
	}
}

/** Gateways: the computers admitted to your Domain. Per-gateway online + session count is derived from the
 * live `teams`; the kebab manages that gateway's sharing or revokes it. Consoles live under Your devices. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GatewaysScreen(
	repo: ChatRepository,
	teams: List<Team>,
	onBack: () -> Unit,
	onAddGateway: () -> Unit,
	onManageSharing: (String) -> Unit,
) {
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	// Re-read after a revoke so the list reflects the change.
	var refresh by remember { mutableStateOf(0) }
	val gateways = remember(refresh) { repo.admittedMembers().filter { it.kind == "gateway" } }
	Scaffold(topBar = { TopAppBar(title = { Text("Gateways") }) }) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text("Computers that run your agents.", style = MaterialTheme.typography.bodyMedium)
			if (gateways.isEmpty()) {
				Text("No Gateways yet. Add one to get started.", style = MaterialTheme.typography.bodyMedium)
			}
			for (g in gateways) {
				val gid = g.gatewayId ?: continue
				val count = teams.count { it.gatewayId == gid }
				val online = teams.any { it.gatewayId == gid && it.status == "online" }
				Card(Modifier.fillMaxWidth()) {
					Row(Modifier.padding(16.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
						Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
							Text(gid, style = MaterialTheme.typography.titleMedium)
							Text(
								"${if (online) "online" else "offline"} · $count session${if (count == 1) "" else "s"}",
								style = MaterialTheme.typography.bodySmall,
							)
							Text(
								Crypto.fingerprint(g.signPub),
								fontFamily = FontFamily.Monospace,
								style = MaterialTheme.typography.bodySmall,
							)
						}
						var menuOpen by remember(g.signPub) { mutableStateOf(false) }
						Box {
							IconButton(onClick = { menuOpen = true }) {
								Icon(Icons.Filled.MoreVert, contentDescription = "Gateway actions")
							}
							DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
								DropdownMenuItem(
									text = { Text("Manage sharing") },
									onClick = {
										menuOpen = false
										onManageSharing(gid)
									},
								)
								DropdownMenuItem(
									text = { Text("Revoke", color = MaterialTheme.colorScheme.error) },
									onClick = {
										menuOpen = false
										scope.launch {
											if (repo.state.value.biometricLock && (activity == null || !promptBiometric(activity))) return@launch
											repo.revokeMember(g.signPub)
											refresh++
										}
									},
								)
							}
						}
					}
				}
			}
			Button(onClick = onAddGateway, modifier = Modifier.fillMaxWidth()) { Text("Add a Gateway") }
			OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Back") }
		}
	}
}

/** Add Gateway: scan the Gateway's admit-gateway QR (or paste the same payload as JSON text),
 * confirm the SAS against the Gateway terminal, then owner-sign + submit the admission. Bundle
 * delivery to a remote Gateway (LAN/paste) follows; a host-configured Gateway (e.g. the local one)
 * gets its admission through evie's domain sync alone. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddGatewayScreen(repo: ChatRepository, onBack: () -> Unit, onDone: () -> Unit) {
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	val context = LocalContext.current
	var scanning by remember { mutableStateOf(false) }
	var scanned by remember { mutableStateOf<ScannedGateway?>(null) }
	var pasteText by remember { mutableStateOf("") }
	var status by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	var pasteBundle by remember { mutableStateOf<String?>(null) }

	// The QR and the JSON-paste method feed the SAME parser: the admit payload the Gateway prints
	// as a QR is the same JSON it offers as copy-pasta, so a scan and a paste land on the identical
	// confirm + admit + deliver path. Null means the text was not an admit-gateway payload.
	fun adopt(payload: String, source: String) {
		// Clear a prior failed attempt's error first, so a good payload's confirm screen never shows
		// the last "not a Gateway code" message next to the valid SAS.
		status = ""
		val parsed = repo.parseAdmitGateway(payload)
		if (parsed == null) status = "That $source is not a Gateway enrollment code." else scanned = parsed
	}

	if (scanning) {
		QrScanScreen(
			onResult = {
				scanning = false
				adopt(it, "QR")
			},
			onCancel = { scanning = false },
		)
		return
	}

	Scaffold(topBar = { TopAppBar(title = { Text("Add Gateway") }) }) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			val s = scanned
			if (s == null) {
				Text("Scan the Gateway's enrollment code, or paste it as JSON.", style = MaterialTheme.typography.bodyMedium)
				if (status.isNotEmpty()) Text(status, color = MaterialTheme.colorScheme.error)
				Button(onClick = { scanning = true }, modifier = Modifier.fillMaxWidth()) { Text("Scan QR") }
				OutlinedTextField(
					value = pasteText,
					onValueChange = { pasteText = it },
					label = { Text("Paste enrollment JSON") },
					modifier = Modifier.fillMaxWidth(),
					minLines = 3,
				)
				Button(
					onClick = { adopt(pasteText.trim(), "code") },
					enabled = pasteText.isNotBlank(),
					modifier = Modifier.fillMaxWidth(),
				) { Text("Use pasted code") }
				OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
			} else {
				Text("Scanned: ${s.gatewayId}", style = MaterialTheme.typography.titleMedium)
				Text("Confirm this matches the Gateway terminal:", style = MaterialTheme.typography.bodyMedium)
				Text(s.sas, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleLarge)
				if (status.isNotEmpty()) Text(status)
				val paste = pasteBundle
				if (paste != null) {
					// LAN delivery was not possible: hand the admin the sealed bundle to paste.
					Button(
						onClick = { copyToClipboard(context, "gateway bundle", paste) },
						modifier = Modifier.fillMaxWidth(),
					) { Text("Copy bundle") }
					OutlinedButton(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text("Done") }
				} else {
					Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
						OutlinedButton(onClick = onBack, enabled = !busy) { Text("Cancel") }
						Button(
							enabled = !busy,
							onClick = {
								busy = true
								status = "Enrolling..."
								scope.launch {
									if (repo.state.value.biometricLock && (activity == null || !promptBiometric(activity))) {
										busy = false
										status = ""
										return@launch
									}
									val result = repo.enrollGateway(s)
									busy = false
									status = result.message
									pasteBundle = result.pasteBundle
									if (result.admitted && result.pasteBundle == null) onDone()
								}
							},
						) { Text("Approve") }
					}
				}
			}
		}
	}
}
