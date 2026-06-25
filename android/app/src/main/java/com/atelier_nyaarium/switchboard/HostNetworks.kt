package com.atelier_nyaarium.switchboard

import android.content.ClipData
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import kotlinx.coroutines.launch

////////////////////////////////
//  Networks you host (guest tenants the operator pre-stages for friends)

/**
 * The host-a-friend admin surface, kept separate from PEERS (hosting != linking). The list shows
 * each staged guest tenant by its network name with a state chip (awaiting-setup -> offline ->
 * online); [+ Add a network] stages a new pending tenant; tapping a row drills into the invite
 * detail (Generate QR / Copy / Save-as-file, plus Remove and Link). The friend scans the one-time
 * invite, their app first-roots their Domain at its silent owner key, and they run their own agents.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostNetworksScreen(repo: ChatRepository, onBack: () -> Unit, onTenant: (String) -> Unit) {
	val state by repo.state.collectAsState()
	// Re-derive the rows on a discovery change (a friend coming online flips a state chip) and after
	// an add/remove (the `refresh` tick).
	var refresh by remember { mutableStateOf(0) }
	val tenants = remember(state.teams, refresh) { repo.hostedTenants() }
	var showAdd by remember { mutableStateOf(false) }

	if (showAdd) {
		AddNetworkScreen(
			repo = repo,
			onBack = { showAdd = false },
			onDone = {
				showAdd = false
				refresh++
			},
		)
		return
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Guest networks") },
				navigationIcon = {
					IconButton(onClick = onBack) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			Text(
				"Networks you set up for friends who have none. They scan a one-time invite and run their " +
					"own agents on their own computer. Hosting doesn't link you.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			if (tenants.isEmpty()) {
				Text(
					"None yet. Add one to invite a friend.",
					style = MaterialTheme.typography.bodyMedium,
				)
			}
			for (t in tenants) {
				HostedTenantRow(tenant = t, onClick = { onTenant(t.domainId) })
			}
			Button(onClick = { showAdd = true }, modifier = Modifier.fillMaxWidth()) { Text("Add a network") }
		}
	}
}

/** One hosted-tenant row: the network name with a state chip and a drill-in chevron. */
@Composable
private fun HostedTenantRow(tenant: HostedTenant, onClick: () -> Unit) {
	Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
		Row(Modifier.padding(16.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
			Column(Modifier.weight(1f)) {
				Text(tenant.profileName, style = MaterialTheme.typography.titleMedium)
				HostedStateLabel(tenant.state)
			}
			Icon(Icons.Default.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

/** The state line under a hosted-tenant row, with a colored dot: awaiting-setup (amber), offline
 * (grey), online (green). */
@Composable
private fun HostedStateLabel(state: HostedTenantState) {
	val (color, text) = when (state) {
		HostedTenantState.AWAITING_SETUP -> Color(0xFFD29922) to "awaiting setup"
		HostedTenantState.OFFLINE -> MaterialTheme.colorScheme.outline to "offline"
		HostedTenantState.ONLINE -> Color(0xFF2EA043) to "online"
	}
	Row(verticalAlignment = Alignment.CenterVertically) {
		Box(Modifier.size(8.dp).clip(CircleShape).background(color))
		Spacer(Modifier.width(6.dp))
		Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	}
}

////////////////////////////////
//  Add a network (stage a pending tenant)

/** Prompt the friend's network name, then stage a pending tenant (provision_tenant). On success
 * evie mints the one-time invite and the row appears as "awaiting setup"; the detail screen renders
 * the invite QR. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddNetworkScreen(repo: ChatRepository, onBack: () -> Unit, onDone: () -> Unit) {
	val scope = rememberCoroutineScope()
	var label by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	var status by remember { mutableStateOf("") }
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("Add a network") },
				navigationIcon = {
					IconButton(onClick = onBack) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(24.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			Text("Name your friend's network", style = MaterialTheme.typography.titleMedium)
			Text(
				"Just a label; they can rename it once in.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			OutlinedTextField(
				value = label,
				onValueChange = { label = it },
				label = { Text("Network name") },
				singleLine = true,
				modifier = Modifier.fillMaxWidth(),
			)
			Button(
				enabled = label.isNotBlank() && !busy,
				onClick = {
					busy = true
					status = "Creating..."
					scope.launch {
						repo.provisionTenant(label)
							.onSuccess { onDone() }
							.onFailure {
								busy = false
								status = "Could not create: ${it.message?.take(140)}"
							}
					}
				},
				modifier = Modifier.fillMaxWidth(),
			) { Text(if (busy) "..." else "Create") }
			if (status.isNotEmpty()) Text(status, style = MaterialTheme.typography.bodySmall)
		}
	}
}

////////////////////////////////
//  Hosted-tenant detail (invite QR + Copy / Save + Remove + Link)

/** A hosted tenant's detail: generate the one-time invite (QR + Copy + Save-as-file) for the
 * friend to scan, regenerate it if it leaks/expires, Remove the tenant, or Link with it (the same
 * cross-Domain Link wizard, once they are online). The invite blob carries the home Gateway's
 * transport creds + the pending {domainId, nonce}; the friend's app first-roots their Domain on
 * scan. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostedTenantDetailScreen(
	repo: ChatRepository,
	domainId: String,
	onBack: () -> Unit,
	onRemoved: () -> Unit,
	onLink: () -> Unit,
	onVerify: (blob: String, peerLabel: String) -> Unit,
) {
	val context = LocalContext.current
	val scope = rememberCoroutineScope()
	val state by repo.state.collectAsState()
	val tenant = remember(state.teams, domainId) { repo.hostedTenants().firstOrNull { it.domainId == domainId } }
	// The invite blob is built lazily (it fetches the gateway transport on demand). Generating it
	// shows the QR; until then the user sees the Generate button.
	var inviteBlob by remember(domainId) { mutableStateOf<String?>(null) }
	var status by remember { mutableStateOf("") }
	var busy by remember { mutableStateOf(false) }
	var confirmRemove by remember { mutableStateOf(false) }

	// A SAF "create document" so the operator can save the invite blob to a file to send.
	val saveLauncher = rememberCreateInvite(context) { status = "Saved." }

	if (tenant == null) {
		// The row was removed elsewhere; bounce back.
		LaunchedEffect(Unit) { onBack() }
		return
	}

	if (confirmRemove) {
		ConfirmDialog(
			title = "Remove ${tenant.profileName}?",
			body = "Drops this network. If your friend set it up, they lose access and need a fresh invite to return.",
			confirmText = "Remove",
			onConfirm = {
				confirmRemove = false
				status = ""
				busy = true
				scope.launch {
					repo.removeHostedTenant(domainId)
						.onSuccess { onRemoved() }
						.onFailure {
							busy = false
							status = "Remove failed: ${it.message?.take(120)}"
						}
				}
			},
			onDismiss = { confirmRemove = false },
		)
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(tenant.profileName) },
				navigationIcon = {
					IconButton(onClick = onBack) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(16.dp),
		) {
			HostedStateBanner(tenant.state)

			val blob = inviteBlob
			if (blob == null) {
				Text(
					"Send your friend this one-time invite to scan or paste. Keep it private - whoever uses it first owns the network.",
					style = MaterialTheme.typography.bodyMedium,
				)
				Button(
					enabled = !busy,
					onClick = {
						busy = true
						status = "Preparing invite..."
						scope.launch {
							repo.buildInviteBlob(tenant)
								.onSuccess {
									inviteBlob = it
									status = ""
								}
								.onFailure { status = "Could not prepare the invite: ${it.message?.take(140)}" }
							busy = false
						}
					},
					modifier = Modifier.fillMaxWidth(),
				) { Text(if (busy) "..." else "Generate invite") }
			} else {
				Text(
					"Show the QR, or send the code by text or file.",
					style = MaterialTheme.typography.bodyMedium,
				)
				QrCode(text = blob) {
					// The blob overflowed a single QR (very large creds): the code-and-file fallbacks
					// below still work, so just explain the missing image.
					Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
						Text(
							"Too large for a QR. Use Copy or Save instead.",
							Modifier.padding(16.dp),
							style = MaterialTheme.typography.bodySmall,
						)
					}
				}
				Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					OutlinedButton(onClick = { copyInvite(context, blob); status = "Copied." }, modifier = Modifier.weight(1f)) {
						Text("Copy")
					}
					OutlinedButton(onClick = { saveLauncher(blob) }, modifier = Modifier.weight(1f)) { Text("Save as file") }
				}
				// After they scan in person, run the mutual 6-digit compare that commits the trust edge.
				Button(onClick = { onVerify(blob, tenant.profileName) }, modifier = Modifier.fillMaxWidth()) {
					Text("Verify in person")
				}
				TextButton(
					enabled = !busy,
					onClick = {
						busy = true
						status = "Regenerating..."
						scope.launch {
							repo.regenerateInvite(domainId, tenant.profileName)
								.onSuccess {
									repo.buildInviteBlob(it)
										.onSuccess { b -> inviteBlob = b; status = "New invite ready. The old one no longer works." }
										.onFailure { e -> status = "Refreshed, but could not rebuild the QR: ${e.message?.take(120)}" }
								}
								.onFailure { status = "Could not refresh: ${it.message?.take(120)}" }
							busy = false
						}
					},
				) { Text("Regenerate invite") }
			}

			if (status.isNotEmpty()) Text(status, style = MaterialTheme.typography.bodySmall)

			HorizontalDivider()

			// Link is the separate cross-Domain pairing (hosting does not link). Available once the
			// friend is online; offered always, with the wizard guiding the both-present ceremony.
			Text(
				"Want your agents to work with theirs? Link separately, once they're set up.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			OutlinedButton(onClick = onLink, modifier = Modifier.fillMaxWidth()) { Text("Link with this network") }

			HorizontalDivider()
			OutlinedButton(
				onClick = { confirmRemove = true },
				enabled = !busy,
				modifier = Modifier.fillMaxWidth(),
			) { Text("Remove this network", color = MaterialTheme.colorScheme.error) }
		}
	}
}

/** The state banner at the top of the detail: awaiting-setup explains the friend has not joined yet
 * (pointing at the manual to bring up their own host), offline/online are status only. */
@Composable
private fun HostedStateBanner(state: HostedTenantState) {
	val text = when (state) {
		HostedTenantState.AWAITING_SETUP ->
			"Waiting for your friend to scan the invite."
		HostedTenantState.OFFLINE -> "Your friend has joined but is offline."
		HostedTenantState.ONLINE -> "Your friend is online."
	}
	Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
		Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
			HostedStateLabel(state)
		}
	}
	Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

////////////////////////////////
//  Helpers

private fun copyInvite(context: Context, value: String) {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? android.content.ClipboardManager ?: return
	cm.setPrimaryClip(ClipData.newPlainText("invite", value))
}

/** A SAF create-document launcher that writes the invite blob to a chosen .json file. Returns a
 * function the UI calls with the blob to save (the blob is captured per save, not at registration). */
@Composable
private fun rememberCreateInvite(context: Context, onSaved: () -> Unit): (String) -> Unit {
	var pending by remember { mutableStateOf<String?>(null) }
	val launcher = androidx.activity.compose.rememberLauncherForActivityResult(
		androidx.activity.result.contract.ActivityResultContracts.CreateDocument("application/json"),
	) { uri ->
		val blob = pending
		pending = null
		if (uri == null || blob == null) return@rememberLauncherForActivityResult
		runCatching {
			context.contentResolver.openOutputStream(uri)?.use { it.write(blob.toByteArray(Charsets.UTF_8)) }
		}.onSuccess { onSaved() }
	}
	return { blob ->
		pending = blob
		launcher.launch("switchboard-invite.json")
	}
}
