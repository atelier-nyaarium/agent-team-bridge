package com.atelier_nyaarium.switchboard

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Process-lifetime repository so chat state survives Activity recreation. */
object Repo {
	@Volatile private var instance: ChatRepository? = null

	fun get(context: Context): ChatRepository =
		instance ?: synchronized(this) {
			instance ?: ChatRepository(ProvisioningStore(context.applicationContext)).also { instance = it }
		}
}

class MainActivity : ComponentActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val repo = Repo.get(this)
		// Optional one-shot provisioning via a base64 JSON intent extra (handy for headless setup).
		val injected = intent.getStringExtra("provisioning_b64")
			?.let { runCatching { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }.getOrNull() }
		setContent { MaterialTheme { App(repo, injected) } }
	}
}

@Composable
fun App(repo: ChatRepository, injectedBlob: String?) {
	val state by repo.state.collectAsState()
	val scope = rememberCoroutineScope()
	var openTeam by remember { mutableStateOf<String?>(null) }

	LaunchedEffect(injectedBlob) {
		if (injectedBlob != null && !state.provisioned) repo.provision(injectedBlob)
	}
	LaunchedEffect(state.provisioned) {
		if (state.provisioned) {
			repo.connect()
			repo.startPolling(scope)
		}
	}

	when {
		!state.provisioned -> ProvisionScreen(onProvision = { scope.launch { repo.provision(it) } })
		openTeam != null ->
			ThreadScreen(
				team = openTeam!!,
				messages = state.threads[openTeam].orEmpty(),
				error = state.error,
				onBack = { openTeam = null },
				onSend = { text -> scope.launch { repo.send(openTeam!!, text) } },
			)
		else ->
			InboxScreen(
				state = state,
				onRefresh = { scope.launch { repo.refreshTeams() } },
				onOpen = { team ->
					repo.openThread(team)
					openTeam = team
				},
			)
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProvisionScreen(onProvision: (String) -> Unit) {
	var blob by remember { mutableStateOf("") }
	Scaffold(topBar = { TopAppBar(title = { Text("Provision Switchboard") }) }) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize(),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text("Paste the provisioning JSON (apiUrl, caPem, saToken, appToken).")
			OutlinedTextField(
				value = blob,
				onValueChange = { blob = it },
				label = { Text("Provisioning JSON") },
				modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp),
			)
			Button(enabled = blob.isNotBlank(), onClick = { onProvision(blob) }) { Text("Save & connect") }
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(state: ChatState, onRefresh: () -> Unit, onOpen: (String) -> Unit) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Inbox") },
				actions = { TextButton(onClick = onRefresh) { Text("Refresh") } },
			)
		},
	) { pad ->
		Column(Modifier.padding(pad).fillMaxSize()) {
			if (state.teams.isEmpty()) {
				LinearProgressIndicator(Modifier.fillMaxWidth())
				Text("  ${state.error ?: state.status.ifEmpty { "connecting..." }}", Modifier.padding(16.dp))
			}
			LazyColumn(Modifier.fillMaxSize()) {
				items(state.teams, key = { it.name }) { team ->
					val unread = state.unread[team.name] ?: 0
					ListItem(
						headlineContent = { Text(team.name) },
						supportingContent = { Text("${team.status} - ${team.mode}") },
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
	messages: List<Message>,
	error: String?,
	onBack: () -> Unit,
	onSend: (String) -> Unit,
) {
	var draft by remember { mutableStateOf("") }
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(team, fontFamily = FontFamily.Monospace) },
				navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
			)
		},
	) { pad ->
		Column(Modifier.padding(pad).fillMaxSize()) {
			LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp)) {
				itemsIndexed(messages) { _, m -> MessageBubble(m) }
			}
			if (error != null) Text(error, Modifier.padding(horizontal = 12.dp))
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

@Composable
fun MessageBubble(m: Message) {
	Box(
		Modifier.fillMaxWidth().padding(vertical = 4.dp),
		contentAlignment = if (m.fromMe) Alignment.CenterEnd else Alignment.CenterStart,
	) {
		Card { Text(m.text, Modifier.padding(10.dp)) }
	}
}
