package com.atelier_nyaarium.switchboard

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		// Optional provisioning via intent extras: a base64 JSON blob (avoids shell
		// escaping) and an autotest flag for headless validation. Also handy for
		// deep-link provisioning later.
		val initial = intent.getStringExtra("provisioning_b64")
			?.let { runCatching { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }.getOrNull() }
			.orEmpty()
		val autoTest = intent.getBooleanExtra("autotest", false)
		setContent { MaterialTheme { SpikeScreen(initial, autoTest) } }
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SpikeScreen(initialBlob: String = "", autoTest: Boolean = false) {
	var blob by remember { mutableStateOf(initialBlob) }
	var status by remember { mutableStateOf("Paste the provisioning JSON, then test the tunnel.") }
	var teams by remember { mutableStateOf<List<String>>(emptyList()) }
	var busy by remember { mutableStateOf(false) }
	val scope = rememberCoroutineScope()

	fun tunnelTest() {
		busy = true
		status = "Testing tunnel..."
		scope.launch {
			status = try {
				val prov = Provisioning.parse(blob)
				withContext(Dispatchers.IO) { PhoneClient(prov).apiReachable() }
			} catch (e: Exception) {
				"Tunnel failed: ${e.message}"
			}
			android.util.Log.i("SpikePhone", "tunnel: $status")
			busy = false
		}
	}

	fun listTeams() {
		busy = true
		status = "Listing teams..."
		scope.launch {
			try {
				val prov = Provisioning.parse(blob)
				val t = withContext(Dispatchers.IO) { PhoneClient(prov).listTeams() }
				teams = t
				status = "Listed ${t.size} team(s)"
			} catch (e: Exception) {
				status = "List failed: ${e.message}"
			}
			busy = false
		}
	}

	LaunchedEffect(Unit) {
		if (autoTest && blob.isNotBlank()) tunnelTest()
	}

	Scaffold(topBar = { TopAppBar(title = { Text("Switchboard tunnel spike") }) }) { pad ->
		Column(
			Modifier
				.padding(pad)
				.padding(16.dp)
				.fillMaxSize()
				.verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			OutlinedTextField(
				value = blob,
				onValueChange = { blob = it },
				label = { Text("Provisioning JSON") },
				modifier = Modifier
					.fillMaxWidth()
					.heightIn(min = 140.dp),
			)
			Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Button(enabled = !busy, onClick = { tunnelTest() }) { Text("Test tunnel") }
				Button(enabled = !busy, onClick = { listTeams() }) { Text("List teams") }
			}
			if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
			Text(status)
			if (teams.isNotEmpty()) {
				HorizontalDivider()
				Text("Teams (${teams.size}):", style = MaterialTheme.typography.titleMedium)
				teams.forEach { Text("- $it", fontFamily = FontFamily.Monospace) }
			}
		}
	}
}
