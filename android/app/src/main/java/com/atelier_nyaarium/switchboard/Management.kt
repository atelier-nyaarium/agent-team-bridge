package com.atelier_nyaarium.switchboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
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

/** The owner root keys + fingerprint the operator feeds to the host's provision-owner
 * setup to root the Domain. Shown before provisioning (the host needs these to root) and
 * under owner settings. Reading them mints the owner identity on first call. */
@Composable
fun OwnerKeysCard(repo: ChatRepository) {
	val context = LocalContext.current
	// Computed once: each read mints-or-loads the keystore-backed owner identity.
	val signPub = remember { repo.ownerSignPub() }
	val boxPub = remember { repo.ownerBoxPub() }
	val sas = remember { repo.ownerSas() }
	Card(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Text("Owner key (this device is the Domain root)", style = MaterialTheme.typography.titleMedium)
			Text(
				"Run the host setup and give it these two keys to root the network at this device. " +
					"Confirm the fingerprint matches what the host prints.",
				style = MaterialTheme.typography.bodySmall,
			)
			Text("Fingerprint: $sas", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
			OutlinedButton(
				onClick = { copyToClipboard(context, "owner signing key", signPub) },
				modifier = Modifier.fillMaxWidth(),
			) { Text("Copy owner signing key") }
			OutlinedButton(
				onClick = { copyToClipboard(context, "owner box key", boxPub) },
				modifier = Modifier.fillMaxWidth(),
			) { Text("Copy owner box key") }
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
				"Export a passphrase-encrypted backup and keep it offline. Anyone with the file AND " +
					"the passphrase controls the network, so choose a strong passphrase.",
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
					scope.launch {
						val blob = repo.exportOwnerBackup(pass1)
						shareText(context, "Switchboard owner key backup", blob)
						status = "Save the backup to a file or password manager, then keep it offline."
					}
				},
				modifier = Modifier.fillMaxWidth(),
			) { Text("Export backup") }

			HorizontalDivider()
			Text("Restore on a fresh install", style = MaterialTheme.typography.titleSmall)
			OutlinedTextField(
				value = restoreBlob,
				onValueChange = { restoreBlob = it },
				label = { Text("Backup blob") },
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
					scope.launch {
						status = when (repo.importOwnerBackup(restoreBlob.trim(), restorePass)) {
							OwnerRestoreResult.OK -> "Owner key restored."
							OwnerRestoreResult.DIFFERENT_OWNER ->
								"That backup is a different owner key. Restore it only on a fresh device."
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

/** Manage networks: the admitted members of the keyring, with revoke, plus Add Switch. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManageScreen(repo: ChatRepository, onBack: () -> Unit, onAddSwitch: () -> Unit) {
	val scope = rememberCoroutineScope()
	// Re-read after an admit/revoke so the board reflects the change.
	var refresh by remember { mutableStateOf(0) }
	val members = remember(refresh) { repo.admittedMembers() }
	Scaffold(topBar = { TopAppBar(title = { Text("Manage networks") }) }) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			if (members.isEmpty()) {
				Text("No members admitted yet. Add a Switch to enroll one.", style = MaterialTheme.typography.bodyMedium)
			}
			for (m in members) {
				Card(Modifier.fillMaxWidth()) {
					Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
						val title = if (m.kind == "switch") (m.switchId ?: "switch") else "console"
						Text(
							if (m.isSelf) "$title  (this device)" else title,
							style = MaterialTheme.typography.titleMedium,
						)
						Text(m.kind, style = MaterialTheme.typography.bodySmall)
						Text(
							Crypto.fingerprint(m.signPub),
							fontFamily = FontFamily.Monospace,
							style = MaterialTheme.typography.bodySmall,
						)
						if (!m.isSelf) {
							TextButton(onClick = {
								scope.launch {
									repo.revokeMember(m.signPub)
									refresh++
								}
							}) { Text("Revoke", color = MaterialTheme.colorScheme.error) }
						}
					}
				}
			}
			Button(onClick = onAddSwitch, modifier = Modifier.fillMaxWidth()) { Text("Add Switch") }
			OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Back") }
		}
	}
}

/** Add Switch: scan the Switch's admit-switch QR, confirm the SAS against the Switch
 * terminal, then owner-sign + submit the admission. Bundle delivery to a remote Switch
 * (LAN/paste) is a later step; a host-configured Switch (e.g. the local one) gets its
 * admission through evie's domain sync alone. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddSwitchScreen(repo: ChatRepository, onBack: () -> Unit, onDone: () -> Unit) {
	val scope = rememberCoroutineScope()
	val context = LocalContext.current
	var scanning by remember { mutableStateOf(true) }
	var scanned by remember { mutableStateOf<ScannedSwitch?>(null) }
	var status by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	var pasteBundle by remember { mutableStateOf<String?>(null) }

	if (scanning) {
		QrScanScreen(
			onResult = {
				scanning = false
				val parsed = repo.parseAdmitSwitch(it)
				if (parsed == null) status = "That QR is not a Switch enrollment code." else scanned = parsed
			},
			onCancel = onBack,
		)
		return
	}

	Scaffold(topBar = { TopAppBar(title = { Text("Add Switch") }) }) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			val s = scanned
			if (s == null) {
				Text(status.ifEmpty { "No Switch scanned." }, color = MaterialTheme.colorScheme.error)
				Button(onClick = { scanning = true }, modifier = Modifier.fillMaxWidth()) { Text("Scan again") }
				OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
			} else {
				Text("Scanned: ${s.switchId}", style = MaterialTheme.typography.titleMedium)
				Text("Confirm this matches the Switch terminal:", style = MaterialTheme.typography.bodyMedium)
				Text(s.sas, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleLarge)
				if (status.isNotEmpty()) Text(status)
				val paste = pasteBundle
				if (paste != null) {
					// LAN delivery was not possible: hand the operator the sealed bundle to paste.
					Button(
						onClick = { copyToClipboard(context, "switch bundle", paste) },
						modifier = Modifier.fillMaxWidth(),
					) { Text("Copy sealed bundle") }
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
									val result = repo.enrollSwitch(s)
									busy = false
									status = result.message
									pasteBundle = result.pasteBundle
									if (result.admitted && result.pasteBundle == null) onDone()
								}
							},
						) { Text("Approve & admit") }
					}
				}
			}
		}
	}
}
