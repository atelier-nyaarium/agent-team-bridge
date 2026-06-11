package com.atelier_nyaarium.switchboard

import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.launch

/** Process-lifetime repository so chat state survives Activity recreation. */
object Repo {
	@Volatile private var instance: ChatRepository? = null

	fun get(context: Context): ChatRepository =
		instance ?: synchronized(this) {
			instance ?: ChatRepository(ProvisioningStore(context.applicationContext)).also { instance = it }
		}
}

// FragmentActivity (not ComponentActivity) so androidx.biometric can attach its prompt.
class MainActivity : FragmentActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val repo = Repo.get(this)
		val injected = intent.getStringExtra("provisioning_b64")
			?.let { runCatching { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }.getOrNull() }
		setContent { MaterialTheme { App(repo, injected) } }
	}
}

@Composable
fun App(repo: ChatRepository, injectedBlob: String?) {
	val state by repo.state.collectAsState()
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? FragmentActivity
	var openTeam by remember { mutableStateOf<String?>(null) }
	var showSettings by remember { mutableStateOf(false) }
	var unlocked by remember { mutableStateOf(false) }

	LaunchedEffect(injectedBlob) {
		if (injectedBlob != null && !state.provisioned) repo.provision(injectedBlob)
	}
	LaunchedEffect(state.provisioned) {
		if (state.provisioned) {
			repo.connect()
			repo.startPolling(scope)
		}
	}

	val locked = state.provisioned && state.biometricLock && !unlocked
	LaunchedEffect(locked) {
		if (locked && activity != null) promptUnlock(activity) { ok -> if (ok) unlocked = true }
	}

	// System back navigates within the app (thread/settings -> inbox) instead of exiting.
	BackHandler(enabled = openTeam != null || showSettings) {
		when {
			openTeam != null -> openTeam = null
			showSettings -> showSettings = false
		}
	}

	when {
		!state.provisioned -> ProvisionScreen(onProvision = { scope.launch { repo.provision(it) } })
		locked -> LockScreen(onUnlock = { activity?.let { a -> promptUnlock(a) { ok -> if (ok) unlocked = true } } })
		showSettings ->
			SettingsScreen(
				state = state,
				onSetDeviceName = { scope.launch { repo.setDeviceName(it) } },
				onToggleBiometric = { repo.setBiometricLock(it) },
				onClear = {
					scope.launch { repo.clearAll() }
					showSettings = false
					openTeam = null
				},
				onBack = { showSettings = false },
			)
		openTeam != null ->
			ThreadScreen(
				team = openTeam!!,
				label = state.label(openTeam!!),
				tabs = state.openTabs,
				tabLabel = { state.label(it) },
				messages = state.threads[openTeam].orEmpty(),
				error = state.error,
				onSwitch = { openTeam = it },
				onCloseTab = { t ->
					repo.closeTab(t)
					if (t == openTeam) openTeam = state.openTabs.firstOrNull { it != t }
				},
				onInbox = { openTeam = null },
				onSend = { text -> scope.launch { repo.send(openTeam!!, text) } },
				onRename = { name -> repo.setLabel(openTeam!!, name) },
				onForget = {
					val t = openTeam!!
					repo.forget(t)
					openTeam = null
				},
			)
		else ->
			InboxScreen(
				state = state,
				onRefresh = { scope.launch { repo.refreshTeams() } },
				onSettings = { showSettings = true },
				onOpen = { team ->
					repo.openThread(team)
					openTeam = team
				},
			)
	}
}

@Composable
fun LockScreen(onUnlock: () -> Unit) {
	Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
		Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
			Text("Switchboard is locked", style = MaterialTheme.typography.titleLarge)
			Button(onClick = onUnlock) { Text("Unlock") }
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProvisionScreen(onProvision: (String) -> Unit) {
	val context = LocalContext.current
	var status by remember { mutableStateOf("") }

	fun tryProvision(text: String?, source: String) {
		val s = text?.trim().orEmpty()
		if (looksProvisionable(s)) {
			status = "Connecting..."
			onProvision(s)
		} else {
			status = "$source did not contain provisioning JSON."
		}
	}

	// SAF file picker. arrayOf("*/*") so a .json with any reported MIME type is selectable.
	val fileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
		if (uri == null) return@rememberLauncherForActivityResult
		val text = runCatching {
			context.contentResolver.openInputStream(uri)?.use { it.readBytes().decodeToString() }
		}.getOrNull()
		tryProvision(text, "File")
	}

	Scaffold(topBar = { TopAppBar(title = { Text("Provision Switchboard") }) }) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize(),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			Text("Load the provisioning blob the host generated for you.")
			Button(
				onClick = { tryProvision(readClipboard(context), "Clipboard") },
				modifier = Modifier.fillMaxWidth(),
			) { Text("Paste from clipboard") }
			Button(
				onClick = { fileLauncher.launch(arrayOf("*/*")) },
				modifier = Modifier.fillMaxWidth(),
			) { Text("Import from file") }
			if (status.isNotEmpty()) {
				val color =
					if (status.startsWith("Connecting")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
				Text(status, color = color)
			}
		}
	}
}

private fun readClipboard(context: Context): String? {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
	return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
}

/** True once the text is a JSON object with the fields a Provisioning needs. */
private fun looksProvisionable(s: String): Boolean = runCatching {
	val j = org.json.JSONObject(s.trim())
	j.has("apiUrl") && j.has("saToken") && j.has("caPem")
}.getOrDefault(false)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(state: ChatState, onRefresh: () -> Unit, onSettings: () -> Unit, onOpen: (String) -> Unit) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Inbox") },
				actions = {
					TextButton(onClick = onRefresh) { Text("Refresh") }
					TextButton(onClick = onSettings) { Text("Settings") }
				},
			)
		},
	) { pad ->
		Column(Modifier.padding(pad).fillMaxSize()) {
			if (state.gap) {
				Text(
					"Some messages were dropped (mailbox overflow). Pull history from the host to recover.",
					Modifier.fillMaxWidth().padding(12.dp),
					color = MaterialTheme.colorScheme.error,
				)
			}
			if (state.teams.isEmpty() && state.threads.isEmpty()) {
				LinearProgressIndicator(Modifier.fillMaxWidth())
				Text("  ${state.error ?: state.status.ifEmpty { "connecting..." }}", Modifier.padding(16.dp))
			}
			LazyColumn(Modifier.fillMaxSize()) {
				items(state.inboxTeams, key = { it.name }) { team ->
					val unread = state.unread[team.name] ?: 0
					val display = state.label(team.name)
					ListItem(
						headlineContent = { Text(display) },
						supportingContent = {
							val idHint = if (display != team.name) "${team.name} - " else ""
							Text("$idHint${team.status} - ${team.mode}")
						},
						trailingContent = { if (unread > 0) Badge { Text("$unread") } },
						modifier = Modifier.fillMaxWidth().clickable { onOpen(team.name) },
					)
					HorizontalDivider()
				}
			}
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadScreen(
	team: String,
	label: String,
	tabs: List<String>,
	tabLabel: (String) -> String,
	messages: List<Message>,
	error: String?,
	onSwitch: (String) -> Unit,
	onCloseTab: (String) -> Unit,
	onInbox: () -> Unit,
	onSend: (String) -> Unit,
	onRename: (String) -> Unit,
	onForget: () -> Unit,
) {
	var draft by remember { mutableStateOf("") }
	var showRename by remember { mutableStateOf(false) }
	val listState = rememberLazyListState()
	LaunchedEffect(messages.size) {
		if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
	}

	if (showRename) {
		RenameDialog(
			team = team,
			current = label,
			onSave = {
				onRename(it)
				showRename = false
			},
			onForget = {
				showRename = false
				onForget()
			},
			onDismiss = { showRename = false },
		)
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(label, fontFamily = FontFamily.Monospace) },
				navigationIcon = { TextButton(onClick = onInbox) { Text("Inbox") } },
				actions = {
					TextButton(onClick = { showRename = true }) { Text("Rename") }
					TextButton(onClick = { onCloseTab(team) }) { Text("Close") }
				},
			)
		},
	) { pad ->
		Column(Modifier.padding(pad).fillMaxSize()) {
			if (tabs.size > 1) {
				val selected = tabs.indexOf(team).coerceAtLeast(0)
				ScrollableTabRow(selectedTabIndex = selected, edgePadding = 8.dp) {
					tabs.forEachIndexed { i, t ->
						Tab(selected = i == selected, onClick = { onSwitch(t) }, text = { Text(tabLabel(t)) })
					}
				}
			}
			LazyColumn(
				state = listState,
				modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
			) {
				itemsIndexed(messages) { _, m -> MessageBubble(m) }
			}
			if (error != null) Text(error, Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.error)
			Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
				OutlinedTextField(
					value = draft,
					onValueChange = { draft = it },
					label = { Text("Message") },
					modifier = Modifier.weight(1f),
				)
				Button(
					enabled = draft.isNotBlank(),
					onClick = {
						onSend(draft)
						draft = ""
					},
					modifier = Modifier.padding(start = 8.dp),
				) { Text("Send") }
			}
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
	state: ChatState,
	onSetDeviceName: (String) -> Unit,
	onToggleBiometric: (Boolean) -> Unit,
	onClear: () -> Unit,
	onBack: () -> Unit,
) {
	var name by remember { mutableStateOf(state.deviceName) }
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Settings") },
				navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize(),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			Text("Device name", style = MaterialTheme.typography.titleMedium)
			Row(verticalAlignment = Alignment.CenterVertically) {
				OutlinedTextField(value = name, onValueChange = { name = it }, modifier = Modifier.weight(1f))
				Button(
					enabled = name.isNotBlank() && name != state.deviceName,
					onClick = { onSetDeviceName(name.trim()) },
					modifier = Modifier.padding(start = 8.dp),
				) { Text("Save") }
			}

			HorizontalDivider()
			Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
				Text("Biometric lock", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
				Switch(checked = state.biometricLock, onCheckedChange = onToggleBiometric)
			}
			Text(
				"Require fingerprint or device PIN on app open. Falls back to unlocked if nothing is enrolled.",
				style = MaterialTheme.typography.bodySmall,
			)

			HorizontalDivider()
			Spacer(Modifier.width(0.dp))
			Button(onClick = onClear) { Text("Clear & re-provision") }
			Text("Removes the stored credential and chat history from this device.", style = MaterialTheme.typography.bodySmall)
		}
	}
}

@Composable
fun RenameDialog(team: String, current: String, onSave: (String) -> Unit, onForget: () -> Unit, onDismiss: () -> Unit) {
	var name by remember { mutableStateOf(if (current == team) "" else current) }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("Rename peer") },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
				Text("Id: $team", style = MaterialTheme.typography.bodySmall)
				OutlinedTextField(
					value = name,
					onValueChange = { name = it },
					label = { Text("Display name") },
					singleLine = true,
				)
			}
		},
		confirmButton = { TextButton(onClick = { onSave(name) }) { Text("Save") } },
		dismissButton = {
			Row {
				TextButton(onClick = onForget) { Text("Forget") }
				TextButton(onClick = onDismiss) { Text("Cancel") }
			}
		},
	)
}

@Composable
fun MessageBubble(m: Message) {
	Box(
		Modifier.fillMaxWidth().padding(vertical = 4.dp),
		contentAlignment = if (m.fromMe) Alignment.CenterEnd else Alignment.CenterStart,
	) {
		Card { Text(m.text, Modifier.padding(10.dp)) }
	}
}
