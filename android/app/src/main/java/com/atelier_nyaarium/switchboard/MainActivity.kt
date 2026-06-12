package com.atelier_nyaarium.switchboard

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.launch

/** Process-lifetime repository so chat state survives Activity recreation. */
object Repo {
	@Volatile private var instance: ChatRepository? = null

	fun get(context: Context): ChatRepository =
		instance ?: synchronized(this) {
			val app = context.applicationContext
			instance ?: ChatRepository(ProvisioningStore(app), app.filesDir, app.contentResolver).also { instance = it }
		}
}

// FragmentActivity (not ComponentActivity) so androidx.biometric can attach its prompt.
class MainActivity : FragmentActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val repo = Repo.get(this)
		val injected = intent.getStringExtra("provisioning_b64")
			?.let { runCatching { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }.getOrNull() }
		setContent {
			val colors = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
			MaterialTheme(colorScheme = colors) { App(repo, injected) }
		}
	}
}

@Composable
fun App(repo: ChatRepository, injectedBlob: String?) {
	val state by repo.state.collectAsState()
	val scope = rememberCoroutineScope()
	val context = LocalContext.current
	val activity = context as? FragmentActivity
	var openTeam by remember { mutableStateOf<String?>(null) }
	var showSettings by remember { mutableStateOf(false) }
	var unlocked by remember { mutableStateOf(false) }

	// WebView pool lives at App scope (never leaves composition) so each thread's
	// renderer survives Sessions round-trips and tab switches. Pruned to open tabs;
	// destroyed with the Activity.
	val rendererPool = remember { ThreadRendererPool(context.applicationContext) }
	val dark = isSystemInDarkTheme()
	LaunchedEffect(dark) { rendererPool.setDark(dark) }
	LaunchedEffect(state.openTabs) { rendererPool.retain(state.openTabs.toSet()) }
	DisposableEffect(Unit) { onDispose { rendererPool.destroyAll() } }

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

	// System back navigates within the app (thread/settings -> sessions) instead of exiting.
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
		openTeam != null -> {
			// The demo session renders through the same Thread pipeline but is fed an
			// in-memory fixture and is read-only, so it never reaches the persisted store.
			// Gated on DEBUG so a real peer named "demo" in a release build shows its own
			// thread, not the fixture.
			val isDemo = BuildConfig.DEBUG && openTeam == DEMO_TEAM
			ThreadScreen(
				team = openTeam!!,
				label = state.label(openTeam!!),
				tabs = state.openTabs,
				tabLabel = { state.label(it) },
				messages = if (isDemo) demoMessages() else state.threads[openTeam].orEmpty(),
				error = state.error,
				rendererPool = rendererPool,
				onSwitch = { openTeam = it },
				onCloseTab = { t ->
					// Move off the closing tab before dropping it from openTabs, so the
					// retain() pass that destroys its renderer never targets the one
					// still on screen.
					if (t == openTeam) openTeam = state.openTabs.firstOrNull { it != t }
					repo.closeTab(t)
				},
				onSessions = { openTeam = null },
				onSend = { text, uris -> if (!isDemo) scope.launch { repo.send(openTeam!!, text, uris) } },
				onRename = { name -> if (!isDemo) repo.setLabel(openTeam!!, name) },
				onForget = {
					val t = openTeam!!
					if (!isDemo) repo.forget(t) else repo.closeTab(t)
					openTeam = null
				},
			)
		}
		else ->
			SessionsScreen(
				state = state,
				showDemo = BuildConfig.DEBUG,
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
fun SessionsScreen(
	state: ChatState,
	showDemo: Boolean,
	onRefresh: () -> Unit,
	onSettings: () -> Unit,
	onOpen: (String) -> Unit,
) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Agent Sessions") },
				actions = {
					TextButton(onClick = onRefresh) { Text("Refresh") }
					TextButton(onClick = onSettings) { Text("Settings") }
				},
			)
		},
	) { pad ->
		Column(Modifier.padding(pad).fillMaxSize()) {
			HealthHeader(state)
			if (state.gap) {
				Surface(
					color = MaterialTheme.colorScheme.errorContainer,
					modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
					shape = MaterialTheme.shapes.medium,
				) {
					Text(
						"Some messages were dropped (mailbox overflow). Pull history from the host to recover.",
						Modifier.padding(12.dp),
						color = MaterialTheme.colorScheme.onErrorContainer,
						style = MaterialTheme.typography.bodySmall,
					)
				}
			}
			if (state.sessions.isEmpty() && !showDemo) {
				if (!state.connected) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
				Text(
					state.error ?: state.status.ifEmpty { "Connecting..." },
					Modifier.padding(16.dp),
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			LazyColumn(
				Modifier.fillMaxSize(),
				contentPadding = PaddingValues(12.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp),
			) {
				if (showDemo) {
					item(key = DEMO_TEAM) { DemoCard(onClick = { onOpen(DEMO_TEAM) }) }
				}
				items(state.sessions, key = { it.name }) { team ->
					SessionCard(state = state, team = team, onClick = { onOpen(team.name) })
				}
			}
		}
	}
}

@Composable
fun HealthHeader(state: ChatState) {
	val (dot, label) = when (state.health) {
		ChatState.Health.ONLINE -> Color(0xFF2EA043) to "Bridge online"
		ChatState.Health.DEGRADED -> Color(0xFFD29922) to "Reconnecting..."
		ChatState.Health.OFFLINE -> Color(0xFFCF222E) to "Offline"
	}
	Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
			Spacer(Modifier.width(8.dp))
			Text(label, style = MaterialTheme.typography.labelLarge)
			Spacer(Modifier.weight(1f))
			if (state.deviceName.isNotEmpty()) {
				Text(
					state.deviceName,
					style = MaterialTheme.typography.labelMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					fontFamily = FontFamily.Monospace,
				)
			}
		}
	}
}

@Composable
private fun StatusChip(text: String, color: Color) {
	Surface(color = color.copy(alpha = 0.16f), shape = MaterialTheme.shapes.small) {
		Row(Modifier.padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
			Box(Modifier.size(7.dp).clip(CircleShape).background(color))
			Spacer(Modifier.width(5.dp))
			Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurface)
		}
	}
}

@Composable
fun SessionCard(state: ChatState, team: Team, onClick: () -> Unit) {
	val display = state.label(team.name)
	val unread = state.unread[team.name] ?: 0
	val live = team.status == "online"
	val statusColor = if (live) Color(0xFF2EA043) else MaterialTheme.colorScheme.outline
	Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
		Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically) {
				Text(
					display,
					style = MaterialTheme.typography.titleMedium,
					fontFamily = FontFamily.Monospace,
					modifier = Modifier.weight(1f),
				)
				if (unread > 0) Badge { Text("$unread") }
			}
			if (display != team.name) {
				Text(
					team.name,
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					fontFamily = FontFamily.Monospace,
				)
			}
			Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
				StatusChip(if (live) "live" else "offline", statusColor)
				team.mode?.let { StatusChip(it, MaterialTheme.colorScheme.primary) }
				Spacer(Modifier.weight(1f))
				state.lastActivity(team.name)?.let {
					Text(
						relativeTime(it),
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			}
			state.snippet(team.name)?.let {
				Text(
					it,
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					maxLines = 1,
					overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
				)
			}
		}
	}
}

@Composable
fun DemoCard(onClick: () -> Unit) {
	Card(
		onClick = onClick,
		modifier = Modifier.fillMaxWidth(),
		colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
	) {
		Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
			Column(Modifier.weight(1f)) {
				Text("Render demo", style = MaterialTheme.typography.titleMedium)
				Text(
					"markdown matrix, debug build only",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSecondaryContainer,
				)
			}
			Badge(containerColor = MaterialTheme.colorScheme.secondary) { Text("demo") }
		}
	}
}

/** Compact relative time for the session cards: now, 5m, 3h, 2d, else a date. */
private fun relativeTime(at: Long): String {
	val delta = System.currentTimeMillis() - at
	return when {
		delta < 60_000 -> "now"
		delta < 3_600_000 -> "${delta / 60_000}m"
		delta < 86_400_000 -> "${delta / 3_600_000}h"
		delta < 604_800_000 -> "${delta / 86_400_000}d"
		else -> java.text.SimpleDateFormat("MMM d", java.util.Locale.getDefault()).format(java.util.Date(at))
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
	rendererPool: ThreadRendererPool,
	onSwitch: (String) -> Unit,
	onCloseTab: (String) -> Unit,
	onSessions: () -> Unit,
	onSend: (String, List<Uri>) -> Unit,
	onRename: (String) -> Unit,
	onForget: () -> Unit,
) {
	var draft by remember { mutableStateOf("") }
	var showRename by remember { mutableStateOf(false) }
	var attachments by remember { mutableStateOf<List<Uri>>(emptyList()) }
	val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
		if (uris.isNotEmpty()) attachments = attachments + uris
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
				navigationIcon = { TextButton(onClick = onSessions) { Text("Sessions") } },
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
			ThreadWebView(
				team = team,
				messages = messages,
				rendererPool = rendererPool,
				modifier = Modifier.weight(1f).fillMaxWidth(),
			)
			if (error != null) Text(error, Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.error)
			if (attachments.isNotEmpty()) {
				Row(
					Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 4.dp),
					horizontalArrangement = Arrangement.spacedBy(6.dp),
				) {
					attachments.forEach { uri ->
						Surface(
							color = MaterialTheme.colorScheme.surfaceVariant,
							shape = MaterialTheme.shapes.small,
						) {
							Row(
								Modifier.padding(start = 10.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
								verticalAlignment = Alignment.CenterVertically,
							) {
								Text(
									uri.lastPathSegment?.substringAfterLast('/') ?: "file",
									style = MaterialTheme.typography.labelSmall,
									maxLines = 1,
									overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
									modifier = Modifier.widthIn(max = 120.dp),
								)
								TextButton(
									onClick = { attachments = attachments - uri },
									contentPadding = PaddingValues(horizontal = 4.dp),
								) { Text("x") }
							}
						}
					}
				}
			}
			Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
				TextButton(onClick = { picker.launch(arrayOf("*/*")) }) { Text("Attach") }
				OutlinedTextField(
					value = draft,
					onValueChange = { draft = it },
					label = { Text("Message") },
					modifier = Modifier.weight(1f),
				)
				Button(
					enabled = draft.isNotBlank() || attachments.isNotEmpty(),
					onClick = {
						onSend(draft, attachments)
						draft = ""
						attachments = emptyList()
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

/**
 * Hosts a thread's pooled WebView inside a FrameLayout. The renderer is pulled from
 * the pool (so scroll position and rendered DOM survive tab switches and Sessions
 * round-trips) and re-fed incrementally via sync(). A crashed renderer is swapped
 * for a fresh one and re-fed.
 */
@Composable
fun ThreadWebView(team: String, messages: List<Message>, rendererPool: ThreadRendererPool, modifier: Modifier) {
	var renderer by remember(team) { mutableStateOf(rendererPool.get(team)) }

	DisposableEffect(renderer) {
		renderer.onRendererGone = { renderer = rendererPool.recreate(team) }
		onDispose { renderer.onRendererGone = null }
	}
	LaunchedEffect(renderer, messages) { renderer.sync(messages) }

	AndroidView(
		factory = { ctx -> FrameLayout(ctx) },
		update = { frame ->
			val wv = renderer.webView
			if (wv.parent !== frame) {
				(wv.parent as? ViewGroup)?.removeView(wv)
				frame.removeAllViews()
				frame.addView(
					wv,
					FrameLayout.LayoutParams(
						FrameLayout.LayoutParams.MATCH_PARENT,
						FrameLayout.LayoutParams.MATCH_PARENT,
					),
				)
			}
		},
		modifier = modifier,
	)
}
