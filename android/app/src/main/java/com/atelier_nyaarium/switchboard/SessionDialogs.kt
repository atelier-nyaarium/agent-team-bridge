package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.delay

////////////////////////////////
//  Composables

/** Dock for a pending scheduled send: a plain sibling in ThreadScreen's Column, stacking above the
 * composer like the Designer dock's threadDockSlots. Tapping reopens [ScheduleSendDialog] to retime
 * it (see onEdit's doc at the ThreadScreen call site for why this is time-only); the trailing icon
 * cancels outright. */
@Composable
fun ScheduledSendDock(rec: ScheduledSend, onEdit: () -> Unit, onCancel: () -> Unit, cancelEnabled: Boolean) {
	// NOT remember-cached: a device timezone change while this composable stays mounted must be
	// picked up on the next recomposition, mirroring IdlePushbackManager's own fresh-read-per-call
	// discipline for the identical value (it takes zone as a supplier invoked fresh every decide()).
	val zone = java.time.ZoneId.systemDefault()
	// Recomputed roughly every minute while the thread is open - "live-ish", not truly ticking
	// per-second, mirroring the cross-domain-presence freshness chip's own periodic-ticker pattern.
	var now by remember { mutableStateOf(System.currentTimeMillis()) }
	LaunchedEffect(rec.opId) {
		while (true) {
			delay(60_000)
			now = System.currentTimeMillis()
		}
	}
	Surface(
		modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
		color = MaterialTheme.colorScheme.secondaryContainer,
		shape = MaterialTheme.shapes.medium,
	) {
		Row(
			Modifier.fillMaxWidth().clickable(onClick = hapticClick(onEdit)).padding(12.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			Icon(Icons.Default.Schedule, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
			Column(Modifier.weight(1f)) {
				Text(
					"Sending at ${absoluteTimeText(rec.fireAtMillis, zone)}",
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onSecondaryContainer,
				)
				Text(
					countdownText(rec.fireAtMillis - now),
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSecondaryContainer,
				)
			}
			// Disabled while the composer holds text, purely as UX - cancelling hands this send's own
			// text and files back into the draft (ChatRepository.takeBackIntoDraft), which itself
			// guards against overwriting whatever is being typed regardless of this flag. Matches the
			// failed-send row's own Cancel.
			IconButton(onClick = hapticClick(onCancel), enabled = cancelEnabled) {
				Icon(
					Icons.Default.Close,
					contentDescription = "Cancel scheduled send",
					tint = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = if (cancelEnabled) 1f else 0.4f),
				)
			}
		}
	}
}

/** Usage-limit notice: the session holds an unanswered limit dialog, so nothing sent to it is read
 * until cleared. A plain sibling in ThreadScreen's Column, stacking above the composer like
 * [ScheduledSendDock] and the plugin dock slots.
 *
 * Deliberately has no dismiss: this is a fact about the session, not a message about it, so hiding it
 * would only hide the affordance that resolves it. Clears itself once the dialog is answered and the
 * daemon's next derivation shows the composer back. */
@Composable
fun SessionLimitDock(detail: String?, onResume: () -> Unit, resumeEnabled: Boolean) {
	Surface(
		modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
		color = MaterialTheme.colorScheme.errorContainer,
		shape = MaterialTheme.shapes.medium,
	) {
		Row(
			Modifier.fillMaxWidth().padding(12.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			Icon(Icons.Default.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
			Column(Modifier.weight(1f)) {
				Text(
					"Session Limit hit",
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onErrorContainer,
				)
				if (detail != null) {
					Text(
						detail,
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.onErrorContainer,
					)
				}
			}
			FilledTonalButton(onClick = hapticClick(onResume), enabled = resumeEnabled) {
				Text(if (resumeEnabled) "Resume" else "Resuming...")
			}
		}
	}
}

/** Cold-wake notice: a wake takes minutes with no wire traffic, so this says so without posting into
 * the transcript. Read-only by design - a wake cannot be called off, so there is nothing to tap and
 * no dismiss; clears itself when the send fails or the team answers (ChatState.wakingTeams). */
@Composable
fun WakingNotice(label: String) {
	Surface(
		modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
		color = MaterialTheme.colorScheme.surfaceVariant,
		shape = MaterialTheme.shapes.medium,
	) {
		Row(
			Modifier.fillMaxWidth().padding(12.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			CircularProgressIndicator(
				modifier = Modifier.size(16.dp),
				strokeWidth = 2.dp,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			Text(
				"Waking $label - first boot can take a minute or two.",
				style = MaterialTheme.typography.bodyMedium,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}

/** Date-then-time picker for banking (or rescheduling) a send. Material3's DatePicker returns UTC
 * millis at the START of the picked calendar day regardless of device zone (documented library
 * behavior), so the pick is converted to a LocalDate then combined with the TimePicker's local
 * hour/minute using the device's REAL zone. Mirrors IdlePushbackManager's ZonedDateTime discipline
 * but is written fresh here: that file's nextAlignedMark is poll-tier only and its hydration clamp
 * targets a PAST-tracking value, the wrong shape for this always-future pick. `initialAtMillis`
 * seeds both steps (5 minutes out for a fresh schedule, the current fire time for a reschedule). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleSendDialog(initialAtMillis: Long, submitting: Boolean, onConfirm: (Long) -> Unit, onDismiss: () -> Unit) {
	val context = LocalContext.current
	// NOT remember-cached: a device timezone change while this composable stays mounted must be
	// picked up on the next recomposition, mirroring IdlePushbackManager's own fresh-read-per-call
	// discipline for the identical value (it takes zone as a supplier invoked fresh every decide()).
	val zone = java.time.ZoneId.systemDefault()
	val seed = remember { java.time.Instant.ofEpochMilli(initialAtMillis).atZone(zone) }
	val dateState = rememberDatePickerState(
		initialSelectedDateMillis = seed.toLocalDate().atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli(),
	)
	val timeState = rememberTimePickerState(
		initialHour = seed.hour,
		initialMinute = seed.minute,
		is24Hour = android.text.format.DateFormat.is24HourFormat(context),
	)
	// rememberSaveable: a rotation/theme/font-scale change destroys and recreates the Activity (no
	// android:configChanges declared anywhere in this app), and dateState/timeState already survive
	// that via their own internal Saver (confirmed - rememberDatePickerState/rememberTimePickerState
	// use rememberSaveable internally) - but this flag deciding WHICH step shows was still plain
	// remember, so the config change closed the dialog outright even though the underlying picker
	// selections would have survived to show it correctly.
	var pickingTime by rememberSaveable { mutableStateOf(false) }

	val pickedMillis = dateState.selectedDateMillis?.let { dateMillis ->
		val day = java.time.Instant.ofEpochMilli(dateMillis).atZone(java.time.ZoneOffset.UTC).toLocalDate()
		day.atTime(timeState.hour, timeState.minute).atZone(zone).toInstant().toEpochMilli()
	}
	// A minute of slack, not a bare `> now` - the picker rejects a past time, and a razor-thin
	// margin here would let a pick go stale by the time the
	// user actually taps Schedule. The DatePicker itself has no upper bound of its own (Material3's
	// default year range is 1900-2100), so a stray far-future pick is rejected too - this feature is
	// for hours-to-days-out reminders, not an unbounded storage commitment (SCHEDULED_SEND_MAX_HORIZON_MS,
	// which ChatRepository.scheduleSend/rescheduleSend also enforce as the authoritative check).
	val tooSoon = pickedMillis == null || pickedMillis <= System.currentTimeMillis() + 60_000
	val tooFarOut = pickedMillis != null && pickedMillis - System.currentTimeMillis() > ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS
	val isFarEnoughOut = !tooSoon && !tooFarOut

	if (!pickingTime) {
		DatePickerDialog(
			onDismissRequest = onDismiss,
			confirmButton = {
				TextButton(enabled = dateState.selectedDateMillis != null, onClick = hapticClick { pickingTime = true }) {
					Text("Next")
				}
			},
			dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
		) {
			DatePicker(state = dateState)
		}
	} else {
		Dialog(onDismissRequest = onDismiss) {
			Surface(shape = MaterialTheme.shapes.extraLarge, tonalElevation = 6.dp) {
				Column(
					Modifier.padding(24.dp),
					horizontalAlignment = Alignment.CenterHorizontally,
					verticalArrangement = Arrangement.spacedBy(20.dp),
				) {
					Text("Send at", style = MaterialTheme.typography.titleMedium)
					TimePicker(state = timeState)
					if (!isFarEnoughOut) {
						Text(
							if (tooFarOut) "Pick a time no more than 30 days out." else "Pick a time at least a minute from now.",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.error,
						)
					}
					Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
						TextButton(onClick = hapticClick { pickingTime = false }) { Text("Back") }
						TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") }
						TextButton(
							// Disabled once tapped, until the caller's async schedule/reschedule call
							// resolves - prevents a double-tap (or a bounced/ghost touch) from launching
							// two overlapping calls that race on the composer's draft.
							enabled = isFarEnoughOut && !submitting,
							onClick = hapticClick { pickedMillis?.let(onConfirm) },
						) { Text("Schedule") }
					}
				}
			}
		}
	}
}

@Composable
fun RenameDialog(team: String, current: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
	var name by remember { mutableStateOf(if (current == team) "" else current) }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("Rename session") },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
				Text("Id: $team", style = MaterialTheme.typography.bodySmall)
				OutlinedTextField(
					value = name,
					onValueChange = { if (it.length <= SESSION_LABEL_MAX_CHARS) name = it },
					label = { Text("Display name") },
					singleLine = true,
				)
			}
		},
		confirmButton = { TextButton(onClick = hapticClick { onSave(name) }) { Text("Save") } },
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

/** Name and spawn a new session, picking the project from a dropdown defaulted to "host". The label
 * is free-form since the gateway mints the session id; the Spawn button enables once it is non-blank.
 * `pendingSpawns` is the full (project, label) set already mid-create (see ChatState.pendingSpawns);
 * the dialog filters to its own `selectedProject`'s labels so the duplicate-submit guard always
 * matches the selected project. A host target also offers a Directory picker (see [DirectoryField]):
 * blank means the label-derived default workdir, and a devcontainer never sends one (fixed workdir). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateSessionDialog(
	projects: List<String>,
	pendingSpawns: Set<Pair<String, String>>,
	onListDirs: suspend (String) -> List<String>,
	onSpawn: (String, String, String?) -> Unit,
	onDismiss: () -> Unit,
) {
	var selectedProject by remember { mutableStateOf("host") }
	var projectMenuOpen by remember { mutableStateOf(false) }
	// A free-form label: the gateway mints the session id, so the label is not slug-constrained.
	var name by remember { mutableStateOf("") }
	var dir by remember { mutableStateOf(TextFieldValue("")) }
	val trimmed = name.trim()
	val dirText = dir.text.trim()
	// Blank is the default workdir; anything else must be rooted before Spawn will send it.
	val dirOk = dirText.isEmpty() || isRootedWorkdir(dirText)
	val pendingLabels = pendingSpawns.filter { it.first == selectedProject }.mapTo(HashSet()) { it.second }
	val isPending = trimmed.isNotEmpty() && trimmed in pendingLabels
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("New session") },
		text = {
			Column {
				ExposedDropdownMenuBox(
					expanded = projectMenuOpen,
					onExpandedChange = { projectMenuOpen = it },
					modifier = Modifier.fillMaxWidth(),
				) {
					OutlinedTextField(
						value = selectedProject,
						onValueChange = {},
						readOnly = true,
						label = { Text("Project") },
						trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = projectMenuOpen) },
						singleLine = true,
						modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
					)
					ExposedDropdownMenu(expanded = projectMenuOpen, onDismissRequest = { projectMenuOpen = false }) {
						for (p in projects) {
							DropdownMenuItem(
								text = { Text(p) },
								onClick = hapticClick {
									selectedProject = p
									projectMenuOpen = false
								},
							)
						}
					}
				}
				Spacer(Modifier.height(12.dp))
				OutlinedTextField(
					value = name,
					onValueChange = { if (it.length <= SESSION_LABEL_MAX_CHARS) name = it },
					label = { Text("Session name") },
					singleLine = true,
					modifier = Modifier.fillMaxWidth(),
				)
				if (selectedProject == "host") {
					Spacer(Modifier.height(12.dp))
					DirectoryField(value = dir, onValueChange = { dir = it }, onListDirs = onListDirs, isError = !dirOk)
				}
				if (isPending) {
					Text(
						"Already creating \"$trimmed\" - wait for it to finish or use a different name.",
						style = MaterialTheme.typography.bodySmall,
					)
				}
			}
		},
		confirmButton = {
			TextButton(
				enabled = trimmed.isNotEmpty() && !isPending && dirOk,
				onClick = hapticClick {
					val workdir = dirText.takeIf { selectedProject == "host" && it.isNotEmpty() }
					onSpawn(selectedProject, trimmed, workdir)
				},
			) { Text("Spawn") }
		},
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

////////////////////////////////
//  Functions & Helpers

/** Whether a typed workdir is a shape the gateway will accept (absolute or ~-rooted); blocks a
 * half-typed fragment before the gateway would reject the whole create. Mirrors host-op.ts
 * isWorkdirPath's shape rule - character rules stay enforced server-side. */
private fun isRootedWorkdir(text: String): Boolean =
	text.startsWith("/") || text == "~" || text.startsWith("~/")

////////////////////////////////
//  Composables

/** Host working-directory picker: a type-ahead path box. The field splits at its last "/" - the
 * prefix names the directory to list (fetched once per directory, cached for the dialog's life), and
 * the fragment after it filters that listing locally, so typing within a segment costs no round-trip
 * and only crossing a "/" boundary does. Blank shows "(default)" (the label-derived workdir); first
 * focus fills "~/" with the cursor after the slash and lists home immediately. Every match renders
 * (no cutoff) in a drag-scrollable box, dot dirs sorted to the bottom and greyed but still selectable;
 * tapping a row completes it plus "/" and descends a level. */
@Composable
fun DirectoryField(
	value: TextFieldValue,
	onValueChange: (TextFieldValue) -> Unit,
	onListDirs: suspend (String) -> List<String>,
	isError: Boolean = false,
) {
	// Per-directory listing cache, keyed by the listed prefix. Missing = not fetched yet; the
	// LaunchedEffect below fills it once per directory.
	val cache = remember { mutableStateMapOf<String, List<String>>() }
	// Suggestions appear once the field is engaged, never under an untouched one: a dialog opened
	// just to name a session should not carry a folder list it never asked for. Text alone also
	// qualifies, so descending (which can move focus to the tapped row) never hides the list
	// mid-navigation.
	var focused by remember { mutableStateOf(false) }
	val text = value.text
	val cut = text.lastIndexOf('/')
	// With no separator typed yet, home is the implied directory and the whole text is its filter.
	// That covers a field cleared back to default (still focused, so the focus prefill cannot fire
	// again) and a bare fragment, neither of which would otherwise have anything to list.
	val parent = if (cut >= 0) text.substring(0, cut + 1) else "~/"
	val fragment = if (cut >= 0) text.substring(cut + 1) else text
	// Only a rooted prefix is listable; a relative one ("foo/") lists nothing.
	val listable = parent.startsWith("/") || parent.startsWith("~/")
	LaunchedEffect(parent, listable, focused) {
		if (listable && (focused || text.isNotEmpty()) && parent !in cache) cache[parent] = onListDirs(parent)
	}
	val engaged = focused || text.isNotEmpty()
	val matches = (if (listable && engaged) cache[parent].orEmpty() else emptyList())
		.filter { it.startsWith(fragment, ignoreCase = true) }
	// Dot dirs to the bottom, greyed below, but present and tappable (a .config dive is legitimate).
	val (dotted, plain) = matches.partition { it.startsWith(".") }
	val suggestions = plain + dotted

	Column {
		OutlinedTextField(
			value = value,
			onValueChange = { if (it.text.length <= WORKDIR_MAX_CHARS) onValueChange(it) },
			label = { Text("Directory") },
			placeholder = { Text("(default)") },
			singleLine = true,
			isError = isError,
			supportingText = if (isError) ({ Text("Pick a folder below, or start with ~/ or /") }) else null,
			trailingIcon = if (text.isEmpty()) null else ({
				IconButton(onClick = hapticClick { onValueChange(TextFieldValue("")) }) {
					Icon(Icons.Default.Close, contentDescription = "Reset to default")
				}
			}),
			modifier = Modifier.fillMaxWidth().onFocusChanged { state ->
				focused = state.isFocused
				if (state.isFocused && text.isEmpty()) {
					onValueChange(TextFieldValue("~/", selection = TextRange(2)))
				}
			},
		)
		if (suggestions.isNotEmpty()) {
			Spacer(Modifier.height(6.dp))
			// A contained, tonal surface so the list reads as a menu rather than as prose under the
			// field. Each row carries a folder icon, a full-width touch target, and a trailing chevron
			// (it descends a level rather than finishing the pick), which is what makes it look tappable.
			Surface(
				color = MaterialTheme.colorScheme.surfaceVariant,
				shape = MaterialTheme.shapes.small,
				modifier = Modifier.fillMaxWidth(),
			) {
				LazyColumn(Modifier.heightIn(max = 280.dp)) {
					items(suggestions, key = { it }) { entry ->
						val hidden = entry.startsWith(".")
						Row(
							Modifier
								.fillMaxWidth()
								.hapticClickable {
									val next = "$parent$entry/"
									onValueChange(TextFieldValue(next, selection = TextRange(next.length)))
								}
								.heightIn(min = 44.dp)
								.padding(horizontal = 12.dp),
							verticalAlignment = Alignment.CenterVertically,
						) {
							Icon(
								Icons.Default.Folder,
								contentDescription = null,
								tint = if (hidden) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.primary,
								modifier = Modifier.size(18.dp),
							)
							Spacer(Modifier.width(10.dp))
							Text(
								entry,
								style = MaterialTheme.typography.bodyMedium,
								color = if (hidden) MaterialTheme.colorScheme.onSurfaceVariant
								else MaterialTheme.colorScheme.onSurface,
								maxLines = 1,
								overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
								modifier = Modifier.weight(1f),
							)
							Icon(
								Icons.Default.ChevronRight,
								contentDescription = null,
								tint = MaterialTheme.colorScheme.onSurfaceVariant,
								modifier = Modifier.size(18.dp),
							)
						}
					}
				}
			}
		}
	}
}
