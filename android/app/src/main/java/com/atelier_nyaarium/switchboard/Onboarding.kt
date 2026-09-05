package com.atelier_nyaarium.switchboard

import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal fun readClipboard(context: Context): String? {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
	return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
}

// The precheck only accepts JSON carrying both Router fields.
internal fun looksProvisionable(s: String): Boolean = runCatching {
	val j = org.json.JSONObject(s.trim())
	j.has("routerUrl") && j.has("routerCertFp")
}.getOrDefault(false)

// Bound picker reads before parsing untrusted files.
internal const val MAX_PROVISION_BLOB_BYTES = 1_000_000L

@Composable
fun LockScreen(onUnlock: () -> Unit) {
	Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
		Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
			Text("Switchboard is locked", style = MaterialTheme.typography.titleLarge)
			Button(onClick = hapticClick(onUnlock)) { Text("Unlock") }
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DomainConnectingScreen(onSettings: () -> Unit) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Set up") },
				actions = { IconButton(onClick = hapticClick(onSettings)) { Icon(Icons.Default.Settings, contentDescription = "Settings") } },
			)
		},
	) { pad ->
		Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.Center) {
			Text("Connecting...", style = MaterialTheme.typography.titleLarge)
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProvisionScreen(
	repo: ChatRepository,
	state: ChatState,
	onProvision: (String) -> Unit,
	onSettings: () -> Unit,
	// Federation health is reachable before any provisioning blob.
	onFederation: () -> Unit = onSettings,
) {
	val context = LocalContext.current
	var status by remember { mutableStateOf("") }
	var scanning by remember { mutableStateOf(false) }
	var showHostHelp by remember { mutableStateOf(false) }
	var addDevice by remember { mutableStateOf(false) }
	// Preserve strict parse errors instead of leaving the screen in a spinner.
	var provisionAttempted by remember { mutableStateOf(false) }
	// Ensure the owner key exists before first-root without crashing startup.
	LaunchedEffect(Unit) { repo.ownerFacts.ownerKeysForDisplay() }

	fun tryProvision(text: String?, source: String) {
		val s = text?.trim().orEmpty()
		if (looksProvisionable(s)) {
			status = "Connecting..."
			provisionAttempted = true
			onProvision(s)
		} else {
			provisionAttempted = false
			status = "No setup code in that $source. Check it, or ask whoever sent it."
		}
	}

	val fileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
		if (uri == null) return@rememberLauncherForActivityResult
		// The wildcard picker requires a size bound before reading.
		val text = runCatching {
			val length = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1
			if (length < 0 || length > MAX_PROVISION_BLOB_BYTES) return@runCatching null
			context.contentResolver.openInputStream(uri)?.use { it.readAllBytes().decodeToString() }
		}.getOrNull()
		tryProvision(text, "file")
	}

	if (scanning) {
		QrScanScreen(
			onResult = {
				scanning = false
				tryProvision(it, "QR")
			},
			onCancel = { scanning = false },
		)
		return
	}

	if (showHostHelp) {
		HostSetupHelpScreen(onBack = { showHostHelp = false })
		return
	}

	if (addDevice) {
		NewDeviceScreen(repo = repo, onBack = { addDevice = false })
		return
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Set up") },
				actions = {
					IconButton(onClick = hapticClick(onSettings)) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			Text("Scan your setup code", style = MaterialTheme.typography.titleLarge)
			Text(
				"Scan or paste the one-time code you were sent.",
				style = MaterialTheme.typography.bodyMedium,
			)
			Button(onClick = hapticClick { scanning = true }, modifier = Modifier.fillMaxWidth()) { Text("Scan QR") }
			Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				OutlinedButton(
					onClick = hapticClick { tryProvision(readClipboard(context), "clipboard") },
					modifier = Modifier.weight(1f),
				) { Text("Paste") }
				OutlinedButton(
					onClick = hapticClick { fileLauncher.launch(arrayOf("*/*")) },
					modifier = Modifier.weight(1f),
				) { Text("Open file") }
			}
			val parseError = state.error?.takeIf { provisionAttempted && it.isNotBlank() }
			val shown = parseError ?: status
			if (shown.isNotEmpty()) {
				val color =
					if (parseError == null && status.startsWith("Connecting")) {
						MaterialTheme.colorScheme.primary
					} else {
						MaterialTheme.colorScheme.error
					}
				Text(shown, color = color)
			}
			Spacer(Modifier.height(8.dp))
			HorizontalDivider()
			TextButton(onClick = hapticClick { addDevice = true }) { Text("Adding another device to your account?") }
			TextButton(onClick = hapticClick { showHostHelp = true }) { Text("Setting up your own Domain?") }
			TextButton(onClick = hapticClick(onFederation)) { Text("Point this phone at your Federation Router") }
		}
	}
}

// The QR carries no owner key or SA token.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewDeviceScreen(repo: ChatRepository, onBack: () -> Unit) {
	val scope = rememberCoroutineScope()
	var scanning by remember { mutableStateOf(false) }
	var scan by remember { mutableStateOf<ScannedDeviceApproval?>(null) }
	var status by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	var waiting by remember { mutableStateOf(false) }

	LaunchedEffect(waiting) {
		val s = scan
		if (!waiting || s == null) return@LaunchedEffect
		while (waiting) {
			repo.devices.newDeviceFetch(s)
				.onSuccess { installed -> if (installed) return@LaunchedEffect }
				.onFailure {
					status = it.message ?: "The approval expired - ask your other device to add it again."
					waiting = false
					return@LaunchedEffect
				}
			delay(2000)
		}
	}

	if (scanning) {
		QrScanScreen(
			onResult = { scanned ->
				scanning = false
				scope.launch {
					val parsed = repo.devices.parseAuthorizeConsole(scanned)
					if (parsed == null) status = "That isn't an add-device code." else scan = parsed.also { status = "" }
				}
			},
			onCancel = { scanning = false },
		)
		return
	}

	Scaffold(topBar = { TopAppBar(title = { Text("Add this device") }) }) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			val s = scan
			when {
				s == null -> {
					Text("Scan the add-device code shown on a device you already use.", style = MaterialTheme.typography.bodyMedium)
					if (status.isNotEmpty()) Text(status, color = MaterialTheme.colorScheme.error)
					Button(onClick = hapticClick { scanning = true }, modifier = Modifier.fillMaxWidth()) { Text("Scan QR") }
					OutlinedButton(onClick = hapticClick(onBack), modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
				}
				waiting -> {
					Text("Waiting for approval", style = MaterialTheme.typography.titleMedium)
					Text("Approve this device on your other device. Its fingerprint:", style = MaterialTheme.typography.bodyMedium)
					Text(s.sas, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleLarge)
					if (status.isNotEmpty()) Text(status)
					OutlinedButton(
						onClick = hapticClick {
							waiting = false
							onBack()
						},
						modifier = Modifier.fillMaxWidth(),
					) { Text("Cancel") }
				}
				else -> {
					Text("Add this device?", style = MaterialTheme.typography.titleMedium)
					Text("This joins the Domain with fingerprint:", style = MaterialTheme.typography.bodyMedium)
					Text(s.sas, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleLarge)
					if (status.isNotEmpty()) Text(status)
					Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
						OutlinedButton(onClick = hapticClick(onBack), enabled = !busy) { Text("Cancel") }
						Button(
							enabled = !busy,
							onClick = hapticClick {
								scope.launch {
									busy = true
									status = "Joining..."
									repo.devices.newDeviceJoin(s)
										.onSuccess {
											waiting = true
											status = ""
										}
										.onFailure { status = it.message ?: "Couldn't reach your other device." }
									busy = false
								}
							},
						) { Text("Add this device") }
					}
				}
			}
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostSetupHelpScreen(onBack: () -> Unit) {
	BackHandler { onBack() }
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Running Gateway Setup") },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text("On your own computer", style = MaterialTheme.typography.titleMedium)
			Text(
				"Only for your own computer. Invited by a friend? Skip this - just scan the code they sent.",
				style = MaterialTheme.typography.bodyMedium,
			)
			HorizontalDivider()
			Text(
				"1. On the computer that will run your agents, clone switchboard and run " +
					"./setup.sh.\n\n" +
					"2. It asks for your name and sets everything up. No keys to paste - this app " +
					"holds your owner key.\n\n" +
					"3. It prints a setup code. Go back and scan or paste it.\n\n" +
					"4. Once connected, add a Gateway in Settings to bring your agents online.",
				style = MaterialTheme.typography.bodyMedium,
			)
		}
	}
}
