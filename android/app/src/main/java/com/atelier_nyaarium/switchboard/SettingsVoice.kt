package com.atelier_nyaarium.switchboard

import android.content.Intent
import android.media.RingtoneManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

////////////////////////////////
//  Functions & Helpers

// Cap the rendered voice menu: some providers ship hundreds of voices, and the
// field's text filters the rest into view.
internal const val MAX_VOICE_MENU_ITEMS = 60

/** The Voice connection's single honest state, shown on the settings status line.
 * DIRTY = creds edited but not yet re-Tested (the voice/Play block stays hidden). */
internal enum class SttsConn { NOT_SET_UP, DIRTY, TESTING, CONNECTED, NO_VOICES, FAILED }

internal suspend fun resolveConn(repo: ChatRepository): Pair<SttsConn, String> =
	foldConn(repo.sttsProbe(), repo.sttsReady())

/** Pure fold of a probe + catalog presence into the honest connection state, so a JVM
 * test pins it: Ok+voices -> CONNECTED, Ok-but-no-catalog -> NO_VOICES (a green status
 * never sits over a dimmed picker), Unreachable -> FAILED with the reason passed through. */
internal fun foldConn(probe: SttsProbe, hasVoices: Boolean): Pair<SttsConn, String> =
	when (probe) {
		is SttsProbe.Ok -> (if (hasVoices) SttsConn.CONNECTED else SttsConn.NO_VOICES) to ""
		is SttsProbe.Unreachable -> SttsConn.FAILED to probe.reason
	}

////////////////////////////////
//  Composables

/** Voice settings for message playback: provider/voice pickers, an audible sample preview, and a
 * service liveness line. Values persist in prefs (not the credential blob) through the repository. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SttsVoiceSection(repo: ChatRepository) {
	val providers = remember { repo.sttsProviders() }
	var providerId by remember { mutableStateOf(repo.sttsProviderId) }
	val current = providers.firstOrNull { it.id == providerId }
	var voice by remember(providerId) { mutableStateOf(repo.sttsVoiceFor(providerId)) }
	var pickerOpen by remember { mutableStateOf(false) }
	var voiceMenuOpen by remember { mutableStateOf(false) }
	var sampleError by remember { mutableStateOf<String?>(null) }
	// Failed previews surface here instead of dead-ending in the log (snapshot
	// state writes are thread-safe, so the player thread can set it directly).
	DisposableEffect(Unit) {
		val errors = repo.stts.addListener { event ->
			val ended = event as? SttsPlayer.Event.Ended
			// Only the sample's own failures belong on this screen; a queue entry failing elsewhere
			// is not this preview's business.
			if (ended != null && ended.team == SttsPlayer.SAMPLE_TEAM && ended.reason != null) {
				sampleError = ended.reason
			}
		}
		onDispose { repo.stts.removeListener(errors) }
	}

	// The voice + playback controls below stay hidden until a Test confirms BOTH the service and a
	// voice catalog, so a green status can never sit over a dimmed picker. Plain remember, NOT
	// rememberSaveable: the store is the durable source, and the secret never enters the
	// saved-instance-state Bundle (a half-typed key resetting on rotation is the right trade).
	var url by remember { mutableStateOf(repo.sttsUrl) }
	var key by remember { mutableStateOf(repo.sttsKey) }
	var conn by remember { mutableStateOf(if (repo.sttsConfigured()) SttsConn.TESTING else SttsConn.NOT_SET_UP) }
	var failReason by remember { mutableStateOf("") }
	// Bumped on every creds edit / Test; a probe ignores its result once the gen moves on, so
	// an edit (or a double-tap) cannot let a stale probe revive a superseded state.
	var probeGen by remember { mutableStateOf(0) }
	val scope = rememberCoroutineScope()
	// The one generation-guarded probe: go TESTING, bump the gen, probe off the main thread, and
	// apply the result only if no newer edit/Test superseded it. Used by both the entry probe and Test.
	val runProbe = {
		conn = SttsConn.TESTING
		val gen = ++probeGen
		scope.launch {
			val (c, r) = resolveConn(repo)
			if (gen == probeGen) {
				conn = c
				failReason = r
			}
		}
	}
	LaunchedEffect(Unit) { if (repo.sttsConfigured()) runProbe() }
	// The provider dialog lives below the Connected gate; if the section collapses (creds
	// edited, or a re-Test fails), drop it so it cannot reappear unbidden on reconnect.
	LaunchedEffect(conn) { if (conn != SttsConn.CONNECTED) pickerOpen = false }

	// A creds edit demotes a resolved state to DIRTY (re-arming the Connected gate so the
	// voice/Play block hides and playback cannot use stale creds), closes the provider dialog,
	// and invalidates any in-flight probe.
	val onCredsEdit = {
		if (conn != SttsConn.NOT_SET_UP && conn != SttsConn.DIRTY) conn = SttsConn.DIRTY
		pickerOpen = false
		probeGen++
	}

	Text("Voice", style = MaterialTheme.typography.titleMedium)
	OutlinedTextField(
		value = url,
		onValueChange = {
			url = it
			onCredsEdit()
		},
		label = { Text("Service URL") },
		singleLine = true,
		modifier = Modifier.fillMaxWidth(),
	)
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedTextField(
			value = key,
			onValueChange = {
				key = it
				onCredsEdit()
			},
			label = { Text("API key") },
			singleLine = true,
			visualTransformation = PasswordVisualTransformation(),
			modifier = Modifier.weight(1f),
		)
		Button(
			enabled = conn != SttsConn.TESTING,
			onClick = hapticClick {
				// setSttsCreds is the validate+persist choke: it normalizes the URL (rejecting
				// userinfo / path / non-https that would send the key to the wrong host), stores the
				// clean origin, and returns it (null = invalid, nothing persisted).
				when {
					key.isBlank() -> conn = SttsConn.NOT_SET_UP
					else -> {
						val origin = repo.setSttsCreds(url, key)
						if (origin == null) {
							conn = SttsConn.FAILED
							failReason = "Use a valid https:// URL"
						} else {
							url = origin
							runProbe()
						}
					}
				}
			},
			modifier = Modifier.padding(start = 8.dp),
		) { Text("Test") }
	}
	Row(verticalAlignment = Alignment.CenterVertically) {
		val statusColor = when (conn) {
			SttsConn.CONNECTED -> Color(0xFF1A7F37)
			SttsConn.NO_VOICES -> Color(0xFF9A6700)
			SttsConn.FAILED -> MaterialTheme.colorScheme.error
			else -> MaterialTheme.colorScheme.onSurfaceVariant
		}
		val statusIcon = when (conn) {
			SttsConn.CONNECTED -> Icons.Default.Check
			SttsConn.NO_VOICES, SttsConn.FAILED -> Icons.Default.Warning
			else -> null
		}
		statusIcon?.let {
			Icon(it, contentDescription = null, tint = statusColor, modifier = Modifier.size(16.dp))
			Spacer(Modifier.width(4.dp))
		}
		Text(
			when (conn) {
				SttsConn.NOT_SET_UP -> "Enter your key to connect"
				SttsConn.DIRTY -> "Press Test to apply"
				SttsConn.TESTING -> "Testing..."
				SttsConn.CONNECTED -> "Connected"
				SttsConn.NO_VOICES -> "Connected, but no voices available"
				SttsConn.FAILED -> "Couldn't connect: $failReason"
			},
			style = MaterialTheme.typography.bodySmall,
			color = statusColor,
		)
	}

	// Voice + Playback unlock only when fully Connected.
	if (conn != SttsConn.CONNECTED) return
	Row(verticalAlignment = Alignment.CenterVertically) {
		OutlinedButton(onClick = hapticClick { pickerOpen = true }) { Text(current?.label ?: providerId.ifEmpty { "Provider" }) }
		ExposedDropdownMenuBox(
			expanded = voiceMenuOpen,
			onExpandedChange = { voiceMenuOpen = it },
			modifier = Modifier.weight(1f).padding(start = 8.dp),
		) {
			OutlinedTextField(
				value = voice,
				onValueChange = {
					voice = it
					repo.setSttsVoiceFor(providerId, it)
					// Surface the filtered matches as the user types, not just on the
					// trailing-icon tap.
					voiceMenuOpen = true
				},
				label = { Text(current?.voiceHint?.let { "$it (blank = default)" } ?: "Voice (blank = default)") },
				trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = voiceMenuOpen) },
				singleLine = true,
				modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryEditable),
			)
			// The catalog ships the provider's full voice list (hundreds for some),
			// so the field text filters the menu by id or label. A Default entry
			// clears to the provider default. The field stays editable: ElevenLabs
			// and Uberduck ship no voices, and a custom id can always be typed.
			val query = voice.trim()
			val matches = current?.voices.orEmpty().filter {
				query.isEmpty() || it.id.contains(query, ignoreCase = true) ||
					(it.label?.contains(query, ignoreCase = true) == true)
			}
			val shown = matches.take(MAX_VOICE_MENU_ITEMS)
			ExposedDropdownMenu(expanded = voiceMenuOpen, onDismissRequest = { voiceMenuOpen = false }) {
				DropdownMenuItem(
					text = { Text("Default voice") },
					onClick = hapticClick {
						voice = ""
						repo.setSttsVoiceFor(providerId, "")
						voiceMenuOpen = false
					},
				)
				for (v in shown) {
					DropdownMenuItem(
						text = {
							Column {
								Text(v.label ?: v.id)
								if (v.label != null && v.label != v.id) {
									Text(
										v.id,
										style = MaterialTheme.typography.bodySmall,
										color = MaterialTheme.colorScheme.onSurfaceVariant,
									)
								}
							}
						},
						onClick = hapticClick {
							voice = v.id
							repo.setSttsVoiceFor(providerId, v.id)
							voiceMenuOpen = false
						},
					)
				}
				if (matches.size > shown.size) {
					DropdownMenuItem(
						enabled = false,
						text = {
							Text(
								"${matches.size - shown.size} more, type to narrow",
								style = MaterialTheme.typography.bodySmall,
							)
						},
						onClick = {},
					)
				}
			}
		}
	}
	current?.note?.let {
		Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}
	Button(
		enabled = current != null,
		onClick = hapticClick {
			sampleError = null
			repo.playback.playSttsSample()
		},
	) {
		Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
		Spacer(Modifier.width(4.dp))
		Text("Play a sample")
	}
	sampleError?.let {
		Text("Playback failed: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}

	PlaybackPreferences(repo)

	if (pickerOpen) {
		AlertDialog(
			onDismissRequest = { pickerOpen = false },
			confirmButton = {},
			title = { Text("Provider") },
			text = {
				Column {
					for (p in providers) {
						TextButton(onClick = hapticClick {
							providerId = p.id
							repo.sttsProviderId = p.id
							voice = repo.sttsVoiceFor(p.id)
							pickerOpen = false
						}) { Text(p.label) }
					}
				}
			},
		)
	}
}

/** The playback preferences below the provider section; they read only the repository. */
@Composable
private fun PlaybackPreferences(repo: ChatRepository) {
	var autoTts by remember { mutableStateOf(repo.sttsAutoGen) }
	Row(verticalAlignment = Alignment.CenterVertically) {
		Column(Modifier.weight(1f)) {
			Text("Pre-generate voice", style = MaterialTheme.typography.titleSmall)
			Text(
				"Pre-synthesize incoming messages for threads you have open, so Play is instant. Adds about 10s to the notification.",
				style = MaterialTheme.typography.bodySmall,
			)
		}
		Switch(
			checked = autoTts,
			onCheckedChange = {
				autoTts = it
				repo.sttsAutoGen = it
			},
		)
	}

	var autoPlay by remember { mutableStateOf(repo.sttsAutoPlay) }
	Column {
		Text("Auto-play new messages", style = MaterialTheme.typography.titleSmall)
		Text(
			"Speak a new message aloud the moment it arrives. Off is silent.",
			style = MaterialTheme.typography.bodySmall,
		)
		Spacer(Modifier.height(4.dp))
		val autoPlayOptions = listOf("off" to "Off", "title" to "Title", "summary" to "Summary", "full" to "Full")
		SingleChoiceSegmentedButtonRow {
			autoPlayOptions.forEachIndexed { index, (value, label) ->
				SegmentedButton(
					selected = autoPlay == value,
					onClick = hapticClick {
						autoPlay = value
						repo.sttsAutoPlay = value
					},
					shape = SegmentedButtonDefaults.itemShape(index = index, count = autoPlayOptions.size),
				) {
					Text(label)
				}
			}
		}
	}

	val chimeContext = LocalContext.current
	var chimeUri by remember { mutableStateOf(repo.sttsChimeUri) }
	// Android's own ringtone picker rather than a file picker: it already lists the sounds the user
	// has, handles the permission, and hands back a Uri.
	val chimePicker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
		if (result.resultCode == android.app.Activity.RESULT_OK) {
			val picked = result.data
				?.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI, android.net.Uri::class.java)
			// A null pick is "Silent", which is a choice rather than an absence: it must not fall back
			// to the bundled sound the way an unset preference does.
			chimeUri = picked?.toString() ?: ChatRepository.CHIME_SILENT
			// The sound is read again on every run, long after this Activity is gone, so ask to keep
			// the grant. A provider that will not persist one simply plays until it stops working,
			// which the resolver already falls back from.
			picked?.let { uri ->
				runCatching {
					chimeContext.contentResolver
						.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
				}
			}
			repo.sttsChimeUri = chimeUri
		}
	}
	Column {
		Text("Run start chime", style = MaterialTheme.typography.titleSmall)
		Text(
			when (chimeUri) {
				"" -> "The bundled chime, once at the start of an automatic run."
				ChatRepository.CHIME_SILENT -> "Silent. A run starts with the session name and no chime."
				else -> "A sound you picked, once at the start of an automatic run."
			},
			style = MaterialTheme.typography.bodySmall,
		)
		Spacer(Modifier.height(4.dp))
		Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			OutlinedButton(
				onClick = hapticClick {
					chimePicker.launch(
						Intent(RingtoneManager.ACTION_RINGTONE_PICKER).apply {
							putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION)
							putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Run start chime")
							putExtra(
								RingtoneManager.EXTRA_RINGTONE_EXISTING_URI,
								chimeUri.takeIf { it.isNotEmpty() }?.let { android.net.Uri.parse(it) },
							)
						},
					)
				},
			) {
				Text("Choose a sound")
			}
			if (chimeUri.isNotEmpty()) {
				TextButton(
					onClick = hapticClick {
						chimeUri = ""
						repo.sttsChimeUri = ""
					},
				) {
					Text("Use bundled")
				}
			}
		}
	}

	// The bubble needs a permission only an Activity can ask for, and the whole point of the bubble is
	// that the app is NOT in front. So the grant is offered here, ahead of time, rather than prompted
	// at the moment it would be useful - by which point there is no Activity to prompt from.
	var canOverlay by remember { mutableStateOf(android.provider.Settings.canDrawOverlays(chimeContext)) }
	val overlayGrant = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
		canOverlay = android.provider.Settings.canDrawOverlays(chimeContext)
	}
	// Re-read on every resume, not only on the launcher's result. This grant is revocable from system
	// settings at any time, and the launcher only ever hears about the trip it started - so a
	// revocation made anywhere else left this row claiming the bubble was on while it had stopped
	// drawing. Same treatment the battery-optimization row already gets, for the same reason.
	androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
		canOverlay = android.provider.Settings.canDrawOverlays(chimeContext)
	}
	Column {
		Text("Floating queue bubble", style = MaterialTheme.typography.titleSmall)
		Text(
			if (canOverlay) {
				"Shows what is left to speak, over other apps."
			} else {
				"Needs permission to draw over other apps. Without it the run still shows in the shade."
			},
			style = MaterialTheme.typography.bodySmall,
		)
		if (!canOverlay) {
			Spacer(Modifier.height(4.dp))
			OutlinedButton(
				// Guarded like the battery-optimization button beside it: not every build ships this
				// settings screen, and the bubble is an addition - failing to open its grant page must
				// not take the settings screen down with it.
				onClick = hapticClick {
					runCatching {
						overlayGrant.launch(
							Intent(
								android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
								android.net.Uri.parse("package:${chimeContext.packageName}"),
							),
						)
					}
				},
			) {
				Text("Allow the bubble")
			}
		}
	}

	var volume by remember { mutableStateOf(repo.sttsVolume) }
	Column {
		Text("Playback volume: $volume%", style = MaterialTheme.typography.titleSmall)
		Slider(
			value = volume.toFloat(),
			onValueChange = { volume = it.toInt() },
			onValueChangeFinished = { repo.sttsVolume = volume },
			valueRange = 0f..200f,
		)
	}

	// Its own slider rather than a share of the speech one. The chime is balanced against the voice
	// that follows it, and a tone pitched to sit under speech is usually louder than anyone wants a
	// sound they hear at the start of every run to be. Written on release, like the one above, so
	// dragging does not thrash prefs.
	var chimeVolume by remember { mutableStateOf(repo.sttsChimeVolume) }
	Column {
		Text("Chime volume: $chimeVolume%", style = MaterialTheme.typography.titleSmall)
		Slider(
			value = chimeVolume.toFloat(),
			onValueChange = { chimeVolume = it.toInt() },
			onValueChangeFinished = { repo.sttsChimeVolume = chimeVolume },
			valueRange = 0f..200f,
		)
		Text(
			"How loud the sound at the start of a run is, relative to the speech after it.",
			style = MaterialTheme.typography.bodySmall,
		)
	}
}
