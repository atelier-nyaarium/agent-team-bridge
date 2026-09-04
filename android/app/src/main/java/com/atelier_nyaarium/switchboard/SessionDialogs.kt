package com.atelier_nyaarium.switchboard

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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/** Every dialog here holds a half-finished intent: a typed goal, a picked time, a draft edit. A tap
 * beside the dialog is usually a mis-hit, so it must not discard one. Back still dismisses. */
private val NO_TAP_AWAY = DialogProperties(dismissOnClickOutside = false)

////////////////////////////////
//  Composables

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
	// which ScheduledSendOps.scheduleSend/rescheduleSend also enforce as the authoritative check).
	val tooSoon = pickedMillis == null || pickedMillis <= System.currentTimeMillis() + 60_000
	val tooFarOut = pickedMillis != null && pickedMillis - System.currentTimeMillis() > ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS
	val isFarEnoughOut = !tooSoon && !tooFarOut

	if (!pickingTime) {
		DatePickerDialog(
			onDismissRequest = onDismiss,
			properties = NO_TAP_AWAY,
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
		Dialog(onDismissRequest = onDismiss, properties = NO_TAP_AWAY) {
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

/** Type what a session should keep working toward. Confirming sends the message and arms the goal
 * against it (GoalOps.armAndSend), which is why the confirm reads as submitting. */
@Composable
fun GoalDialog(submitting: Boolean, onConfirm: (String) -> Unit, onDismiss: () -> Unit) {
	var goal by remember { mutableStateOf("") }
	AlertDialog(
		onDismissRequest = onDismiss,
		properties = NO_TAP_AWAY,
		title = { Text("Set a goal") },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
				Text("Goal Description", style = MaterialTheme.typography.bodySmall)
				// No label: it would sit inside the empty field, ghosting a second name under the one above.
				OutlinedTextField(
					value = goal,
					onValueChange = { if (it.length <= GOAL_MAX_CHARS) goal = it },
					placeholder = { Text("Complete the plan") },
					singleLine = true,
				)
			}
		},
		confirmButton = {
			TextButton(onClick = hapticClick { onConfirm(goal) }, enabled = goal.isNotBlank() && !submitting) {
				Text(if (submitting) "Sending..." else "Goal")
			}
		},
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
	// The Gateway this was opened on, named in the title. Every Gateway offers Create and every one of
	// them has a `host`, so the dialog is otherwise identical whichever machine it will spawn on.
	gateway: String,
	projects: List<String>,
	pendingSpawns: Set<Pair<String, String>>,
	// A picked project's spawn target. The dialog never spells an address itself: the caller owns which
	// Gateway this was opened on, and a project name alone would resolve to the polled one.
	targetOf: (String) -> String,
	// (path, spawn point). The spawn names WHICH filesystem to browse: a windows session is listed by
	// Windows itself, so the picker cannot offer a Linux directory its launch would then refuse.
	onListDirs: suspend (String, String) -> DirListing,
	// The project this Gateway was last spawned on, if it still offers it. Only a suggestion.
	rememberedProject: String?,
	onSpawn: (String, String, String?) -> Unit,
	onDismiss: () -> Unit,
) {
	// Null until picked. `host` is not a neutral default - it is one real target among several, so
	// preselecting it lets a mis-tap spawn on the wrong machine's shell in silence.
	var selectedProject by remember { mutableStateOf(initialProject(rememberedProject, projects)) }
	var projectMenuOpen by remember { mutableStateOf(false) }
	// A free-form label: the gateway mints the session id, so the label is not slug-constrained.
	var name by remember { mutableStateOf("") }
	var dir by remember { mutableStateOf(TextFieldValue("")) }
	val trimmed = name.trim()
	val dirText = dir.text.trim()
	// Blank is the default workdir; anything else must be rooted before Spawn will send it.
	val dirOk = dirText.isEmpty() || (selectedProject != null && isRootedFor(selectedProject!!, dirText))
	val selectedTarget = selectedProject?.let(targetOf)
	// Keyed on the TARGET, not the project: two machines each have a `host`, and the same label is in
	// flight on only one of them.
	val pendingLabels = pendingSpawns.filter { it.first == selectedTarget }.mapTo(HashSet()) { it.second }
	val isPending = trimmed.isNotEmpty() && trimmed in pendingLabels
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(if (gateway.isEmpty()) "New session" else "New session on $gateway") },
		text = {
			Column {
				ExposedDropdownMenuBox(
					expanded = projectMenuOpen,
					onExpandedChange = { projectMenuOpen = it },
					modifier = Modifier.fillMaxWidth(),
				) {
					OutlinedTextField(
						// The SAME label the menu rows use. These disagreed once: the field showed the
						// wire word while the open menu showed the label, so one thing read as `host`
						// and `WSL` at the same time depending on whether the menu was open.
						value = selectedProject?.let { hostSpawnLabel(it, projects) } ?: "",
						onValueChange = {},
						readOnly = true,
						label = { Text("Project") },
						placeholder = { Text("Choose one") },
						trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = projectMenuOpen) },
						singleLine = true,
						modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
					)
					ExposedDropdownMenu(expanded = projectMenuOpen, onDismissRequest = { projectMenuOpen = false }) {
						for (p in projects) {
							DropdownMenuItem(
								// Label only. `selectedProject` keeps the wire word, which is an address
								// segment keying session records, resume state and board work.
								text = { Text(hostSpawnLabel(p, projects)) },
								onClick = hapticClick {
									// The picked directory belongs to the filesystem it was browsed on, so
									// changing spawn point retires it. Carrying it over lets a `~/project`
									// ride onto a Windows session (whose validator accepts POSIX shapes,
									// then refuses the UNC it translates to) and a `C:/...` ride onto the
									// host, where it is simply not a path.
									if (p != selectedProject) dir = TextFieldValue("")
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
				// Every host spawn point takes a picked directory; a devcontainer's is fixed. Nothing
				// picked shows no field at all: there is no filesystem to browse yet.
				selectedProject?.takeIf { it in HOST_SPAWN_IDS }?.let { spawn ->
					Spacer(Modifier.height(12.dp))
					DirectoryField(
						value = dir,
						onValueChange = { dir = it },
						spawn = spawn,
						onListDirs = onListDirs,
						isError = !dirOk,
					)
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
				// A project is now part of the answer, not a default, so Spawn waits for one.
				enabled = selectedTarget != null && trimmed.isNotEmpty() && !isPending && dirOk,
				onClick = hapticClick {
					val project = selectedProject ?: return@hapticClick
					val target = selectedTarget ?: return@hapticClick
					val workdir = dirText.takeIf { project in HOST_SPAWN_IDS && it.isNotEmpty() }
					onSpawn(target, trimmed, workdir)
				},
			) { Text("Spawn") }
		},
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

////////////////////////////////
//  Functions & Helpers

// The gateway's displayLabel/sessionLabel wire schema caps both at 64 characters; enforced
// client-side too so pasting a long string reads as "can't type more" rather than a confusing
// server-side rejection once submitted.
internal const val SESSION_LABEL_MAX_CHARS = 64

internal const val WORKDIR_MAX_CHARS = 512

/** Whether a typed workdir is a shape the gateway will accept (absolute or ~-rooted); blocks a
 * half-typed fragment before the gateway would reject the whole create. Mirrors host-op.ts
 * isWorkdirPath's shape rule - character rules stay enforced server-side. */
private fun isRootedWorkdir(text: String): Boolean =
	text.startsWith("/") || text == "~" || text.startsWith("~/")

/** A Windows path, with FORWARD slashes. Backslash is forbidden on this wire for shell-nesting
 * reasons and stays that way; PowerShell takes `C:/Users/me` everywhere it takes the other form.
 * Mirrors the gateway's `isWindowsWorkdirPath`, which is what actually enforces it. */
private val WINDOWS_ROOTED = Regex("^[A-Za-z]:/")

/** The path rule for whichever spawn point is selected. A windows session accepts either shape: the
 * picker walks Windows and yields `C:/...`, and a `/mnt/c/...` path still translates at launch. */
private fun isRootedFor(project: String, text: String): Boolean =
	if (project == "windows") WINDOWS_ROOTED.containsMatchIn(text) || isRootedWorkdir(text) else isRootedWorkdir(text)

/** The wire spelling for the Windows drive list. Twin of `WINDOWS_DRIVE_ROOT` in `windowsSpawn.ts`. */
private const val WINDOWS_DRIVE_ROOT = "/"

/**
 * What one field's text says to browse: the directory to list, the fragment filtering it, the path
 * the op carries, and whether there is anything to list at all.
 *
 * Windows has no home to imply, so an empty field browses the DRIVES rather than nothing. That is
 * what makes the field answer a tap at all, and every listing below a drive is rooted the only way
 * the launch accepts. Elsewhere home is the implied directory, as it always was.
 */
internal data class DirBrowse(val parent: String, val fragment: String, val listPath: String, val listable: Boolean)

internal fun dirBrowse(text: String, isWindows: Boolean): DirBrowse {
	val cut = text.lastIndexOf('/')
	val parent = if (cut >= 0) text.substring(0, cut + 1) else if (isWindows) "" else "~/"
	val fragment = if (cut >= 0) text.substring(cut + 1) else text
	val listable =
		if (isWindows) parent.isEmpty() || WINDOWS_ROOTED.containsMatchIn(parent)
		else parent.startsWith("/") || parent.startsWith("~/")
	return DirBrowse(
		parent = parent,
		fragment = fragment,
		listPath = if (parent.isEmpty()) WINDOWS_DRIVE_ROOT else parent,
		listable = listable,
	)
}

////////////////////////////////
//  Composables

/** Host working-directory picker: a type-ahead path box. The field splits at its last "/" - the
 * prefix names the directory to list (fetched once per directory, cached for the dialog's life), and
 * the fragment after it filters that listing locally, so typing within a segment costs no round-trip
 * and only crossing a "/" boundary does. Blank shows "(default)" (the label-derived workdir); first
 * focus fills "~/" with the cursor after the slash and lists home immediately, and on Windows lists
 * the drives instead, since that machine has no home to imply. Every match renders
 * (no cutoff) in a drag-scrollable box, dot dirs sorted to the bottom and greyed but still selectable;
 * tapping a row completes it plus "/" and descends a level. */
@Composable
fun DirectoryField(
	value: TextFieldValue,
	onValueChange: (TextFieldValue) -> Unit,
	/** Which spawn point's filesystem this field browses. Decides both the listing and what counts
	 * as a listable prefix, since a Windows path is rooted at a drive rather than at `/`. */
	spawn: String,
	// (path, spawn point). The spawn names WHICH filesystem to browse: a windows session is listed by
	// Windows itself, so the picker cannot offer a Linux directory its launch would then refuse.
	onListDirs: suspend (String, String) -> DirListing,
	isError: Boolean = false,
) {
	// Per-directory cache of SUCCESSFUL listings, keyed by the listed prefix. Missing = not fetched
	// yet, which is what makes the fetch below happen at all.
	val cache = remember { mutableStateMapOf<String, List<String>>() }
	// Why a directory has no listing, kept apart from the cache ON PURPOSE. Caching a failure as if it
	// were a listing makes it permanent for the dialog's life: the machine comes back, the owner
	// retypes the same path, and the fetch never re-runs because the key is present. A failure is a
	// fact about one moment, so it is displayed and then stands aside for the next attempt.
	val failures = remember { mutableStateMapOf<String, String>() }
	// Suggestions appear once the field is engaged, never under an untouched one: a dialog opened
	// just to name a session should not carry a folder list it never asked for. Text alone also
	// qualifies, so descending (which can move focus to the tapped row) never hides the list
	// mid-navigation.
	var focused by remember { mutableStateOf(false) }
	val text = value.text
	// With no separator typed yet, home is the implied directory and the whole text is its filter.
	// That covers a field cleared back to default (still focused, so the focus prefill cannot fire
	// again) and a bare fragment, neither of which would otherwise have anything to list. On Windows
	// the drives stand in for home. See `dirBrowse`.
	val isWindows = spawn == "windows"
	val (parent, fragment, listPath, listable) = dirBrowse(text, isWindows)
	// Retries a failed directory whenever these keys change again (a refocus, or moving away and back),
	// which is the recovery path once the machine is reachable. Unchanged keys do not re-run it, so a
	// machine that stays down is asked once per attempt rather than continuously.
	LaunchedEffect(parent, listable, focused) {
		if (!listable || !(focused || text.isNotEmpty()) || parent in cache) return@LaunchedEffect
		val listing = onListDirs(listPath, spawn)
		if (listing.error == null) {
			cache[parent] = listing.dirs
			failures.remove(parent)
		} else {
			failures[parent] = listing.error
		}
	}
	val engaged = focused || text.isNotEmpty()
	val showing = listable && engaged
	val failure = if (showing) failures[parent] else null
	val matches = (if (showing) cache[parent].orEmpty() else emptyList())
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
			// A failed listing takes the supporting line, since a rooted path the picker could not read
			// is the more useful thing to say about it than the rooting rule it already satisfies.
			isError = isError || failure != null,
			supportingText = failure?.let { { Text(it) } }
				?: if (isError) {
					({ Text(if (isWindows) "Start with a drive, like C:/" else "Pick a folder below, or start with ~/ or /") })
				} else {
					null
				},
			trailingIcon = if (text.isEmpty()) null else ({
				IconButton(onClick = hapticClick { onValueChange(TextFieldValue("")) }) {
					Icon(Icons.Default.Close, contentDescription = "Reset to default")
				}
			}),
			modifier = Modifier.fillMaxWidth().onFocusChanged { state ->
				focused = state.isFocused
				// A Windows session has no `~`, so prefilling one there hands the owner a path its own
				// validator rejects and makes them clear it before they can type a drive. Left empty
				// instead, which is also the value that means "the Windows home".
				if (state.isFocused && text.isEmpty() && !isWindows) {
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

@Composable
fun SessionActionsDialog(
	label: String,
	canRename: Boolean,
	onRename: () -> Unit,
	onForget: () -> Unit,
	onDismiss: () -> Unit,
) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(label, fontFamily = FontFamily.Monospace) },
		text = {
			Column {
				if (canRename) {
					TextButton(onClick = hapticClick(onRename), modifier = Modifier.fillMaxWidth()) { Text("Rename") }
				} else {
					Text(
						"Project names come from the Gateway and cannot be renamed.",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				TextButton(onClick = hapticClick(onForget), modifier = Modifier.fillMaxWidth()) { Text("Forget...") }
			}
		},
		confirmButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

@Composable
fun ConfirmDialog(title: String, body: String, confirmText: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(title) },
		text = { Text(body) },
		confirmButton = { TextButton(onClick = hapticClick(onConfirm)) { Text(confirmText) } },
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

/** Forgetting a session with unfinished board work: cancel the tasks (trash with the session) or
 * unassign them (return to the backlog). Dismissing abandons the forget rather than deciding by inaction. */
@Composable
internal fun BoardForgetDialog(
	label: String,
	undone: Int,
	onCancelTasks: () -> Unit,
	onUnassign: () -> Unit,
	onDismiss: () -> Unit,
) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("Forget $label?") },
		text = {
			Text(
				"It still holds $undone unfinished task${if (undone == 1) "" else "s"}. " +
					"Finished ones go to the trash either way.",
			)
		},
		confirmButton = { TextButton(onClick = hapticClick(onUnassign)) { Text("Back to the backlog") } },
		dismissButton = { TextButton(onClick = hapticClick(onCancelTasks)) { Text("Mark cancelled") } },
	)
}
