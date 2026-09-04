package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardControlKey
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

////////////////////////////////
//  Functions & Helpers

/**
 * Whether the terminal should stop peeking and read as asleep.
 *
 * A presence row says whether an AGENT registered. It never says whether the tmux PANE exists, and
 * those two differ for the whole time the owner has closed Claude to use the shell underneath. So an
 * "available" row is not evidence that there is nothing to show, however authoritative it is: the
 * terminal probes while reachable and lets the pane itself answer. That probe is the difference
 * between coming back to a working terminal and coming back to "This session is asleep" over a shell
 * that is sitting right there.
 *
 * A wake this device asked for keeps the terminal watching for the pane to appear, but it cannot
 * override an unreachable Gateway: every peek there is a guaranteed round trip to a machine already
 * known to be out of reach, which is the bound that keeps one Wake tap on a powered-off machine from
 * becoming an endless poll.
 *
 * A reachable terminal without a pane keeps probing until a successful answer establishes that
 * there is nothing to show.
 */
internal fun terminalReadsAsleep(
	presence: Presence?,
	wakeRequested: Boolean,
	sawPane: Boolean,
	probed: Boolean,
	now: Long,
): Boolean {
	if (presence == null || sawPane) return false
	if (!presence.gatewayReachable) return true
	if (wakeRequested) return false
	return !presence.mayHavePane(now) && probed
}

////////////////////////////////
//  Composables

/**
 * The console terminal view. It always peeks; the render follows the peek result:
 *  - a live tmux pane (ANSI, auto-refreshed while RESUMED) with the control-key + slash palette and a
 *    text input that injects via tmux_send; while the session is not online the slash-macro row (claude
 *    TUI commands, nothing to receive them) swaps to a Wake up button firing onRelaunch;
 *  - a read-only container-logs snapshot while the session's tmux pane does not exist yet (a booting
 *    devcontainer), with no input since there is nothing to type into;
 *  - a centered Wake button ONLY when a successful probe found no pane, or the Gateway cannot be reached. A
 *    status drop back to "available" (Claude closed, tmux itself untouched) keeps showing that pane,
 *    with the Wake up button in the key row rather than over the terminal. See [terminalReadsAsleep].
 * onPeek carries the last hash so an idle frame round-trips only the hash, and returns a Result so a
 * never-loaded pane can show the backend's reason instead of staying blank. `wakePending` seeds the
 * waking state for a session opened straight off a create/wake, so it reads "Waking..." not "asleep".
 */
@Composable
fun TerminalView(
	team: String,
	refreshMs: Long,
	presence: Presence?,
	onWake: () -> Unit,
	// Force-relaunch claude in a pane that still exists (close_session + create_session composed -
	// see SessionOps.relaunchSession for why a bare wake cannot). Throws on failure.
	onRelaunch: suspend () -> Unit,
	onPeek: suspend (sinceHash: String?) -> Result<ConsolePeekResult>,
	onSend: suspend (text: String?, key: String?, submit: Boolean) -> Unit,
	// Answer a usage-limit dialog with choice 1 and type "resume". Throws on failure.
	onResumeAfterLimit: suspend () -> Unit,
	onFocusChange: (FocusIntent) -> Unit = {},
	modifier: Modifier = Modifier,
) {
	// Declares terminal focus while this session's terminal is on screen, at the SAME rate its own
	// peek loop below runs at, so the Gateway's intent tracker ramps the host daemon's derivation
	// cadence for exactly this team - belt and suspenders with the terminal's own rendering peek,
	// which already implies terminal intent (item 5's own doc). Re-declares on a team/rate change
	// (switching sessions, or a settings edit); on dispose (closing the terminal, or leaving the
	// screen) falls back to "background" rather than assuming what comes next - whatever screen
	// takes over (the board, another thread) declares its own focus shortly after, and the
	// intent's own TTL self-heals even if nothing does.
	DisposableEffect(team, refreshMs) {
		onFocusChange(FocusIntent(screen = "terminal", terminalTeam = team, terminalRateMs = refreshMs))
		onDispose { onFocusChange(FocusIntent(screen = "background")) }
	}
	var ansi by remember(team) { mutableStateOf("") }
	var logs by remember(team) { mutableStateOf("") }
	var kind by remember(team) { mutableStateOf<String?>(null) }
	var lastHash by remember(team) { mutableStateOf<String?>(null) }
	var input by remember(team) { mutableStateOf("") }
	var sendError by remember(team) { mutableStateOf<String?>(null) }
	var peekError by remember(team) { mutableStateOf<String?>(null) }
	// Consecutive peek failures. A single blip keeps the last frame (no flicker); a run of them means
	// the session actually went away, so the wake/error screen takes over even after a frame had loaded.
	var failCount by remember(team) { mutableIntStateOf(0) }
	// A wake has been asked for (a create/wake opened this thread, or the Wake button was tapped), so
	// the off-session screen reads "Waking..." and offers Retry rather than a first-time "Wake".
	// Seeded from the repository's own outstanding receipt rather than from a status word: this
	var wakeRequested by remember(team) { mutableStateOf(presence?.waking(System.currentTimeMillis()) == true) }
	// Whether this mount has received a successful probing answer. A pane latches everSawTmuxFrame;
	// an absent one hands the question back to the idle gate.
	var probed by remember(team) { mutableStateOf(false) }
	// A long-press freezes the frame (this halts peeking) so its text can be selected and copied
	// without the next frame wiping the selection; the Paused banner resumes.
	var paused by remember(team) { mutableStateOf(false) }
	// Latched true the first time THIS mount peeks a real tmux pane, and never reset - a capturable
	// pane is direct, fresher evidence than any status word that there is something to look at.
	// Closing Claude drops the gateway's confirmed incarnation back to "available" while leaving the
	// pane alive, and that pane keeps showing. A fresh mount starts over and re-earns it with the one
	// probe, which is what makes leaving the thread and coming back land on the terminal again.
	var everSawTmuxFrame by remember(team) { mutableStateOf(false) }
	// The Wake up button's in-flight latch (the close_session + create_session round trip), so a
	// double-tap cannot fire a second chain whose close would kill the first chain's fresh session.
	var relaunching by remember(team) { mutableStateOf(false) }
	// The Resume button's own in-flight latch, so a double-tap cannot inject the three-send sequence
	// twice and leave a stray "resume" staged in the composer.
	var resuming by remember(team) { mutableStateOf(false) }
	val scope = rememberCoroutineScope()
	val lifecycleOwner = LocalLifecycleOwner.current

	LaunchedEffect(team, refreshMs, presence) {
		lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
			while (true) {
				// A long-press pause freezes the frame; a session with nothing to peek idles on the Wake
				// screen rather than docker-exec'ing a warm container every cycle. See
				// [terminalReadsAsleep] for what counts as nothing.
				val idle = terminalReadsAsleep(presence, wakeRequested, everSawTmuxFrame, probed, System.currentTimeMillis())
				if (paused || idle) {
					delay(refreshMs)
					continue
				}
				onPeek(lastHash)
					.onSuccess { r ->
						// The frame is a live pane (ansi) or a pre-pane container-logs snapshot (text),
						// tagged by kind; an unchanged frame carries neither and keeps the last one.
						if (r.unchanged != true) {
							when (r.kind) {
								"container-logs" -> if (r.text != null) {
									logs = r.text
									kind = "container-logs"
								}
								else -> if (r.ansi != null) {
									ansi = r.ansi
									kind = "tmux"
									everSawTmuxFrame = true
								}
							}
						}
						lastHash = r.hash
						peekError = null
						failCount = 0
						// Marked once the answer is IN, not once the request goes out: a probe still in flight is
						// not evidence of an empty pane, and stamping it early flashes the Wake screen over a
						// terminal that is about to render.
						probed = true
					}
					.onFailure {
						peekError = it.message ?: "terminal unavailable"
						failCount++
					}
				// Back off while the session is not answering (asleep, stuck, or user-launched) so a
				// long-open terminal does not docker-exec every cycle forever; a success resets to base.
				delay(refreshMs * failCount.coerceIn(1, 8).toLong())
			}
		}
	}

	// Drop the waking latch only once the gateway confirms "online" (MCP registered AND the lead
	// handshake completed) - the same signal the board tile's spinner keys off. A freshly created tmux
	// pane can be peeked well before the Claude CLI inside it has started, so a capturable pane alone
	// is not sufficient; only the "online" signal is trusted.
	LaunchedEffect(team, presence) {
		if (presence?.isOnline == true) wakeRequested = false
	}

	fun fire(text: String?, key: String?, submit: Boolean = true) {
		scope.launch {
			sendError = null
			runCatchingCancellable { onSend(text, key, submit) }.onFailure { sendError = it.message ?: "send failed" }
		}
	}

	val frameEmpty = ansi.isEmpty() && logs.isEmpty()
	// Derived from this view's own frame rather than the presence plane: the terminal already holds the
	// pane, so the affordance appears on the same frame the dialog does instead of waiting out the
	// daemon's 2-peek hysteresis and the next poll.
	val limit = remember(ansi) { if (ansi.isEmpty()) null else AgentScreen.limitNotice(ansi) }
	// The same call the peek loop makes, so the screen and the polling cannot disagree about whether
	// this session is asleep. Two answers to one question is what wrote the blank-terminal defect.
	val asleepIdle =
		terminalReadsAsleep(presence, wakeRequested, everSawTmuxFrame, probed, System.currentTimeMillis())
	// The wake/error screen shows once there is no frame to display (a failed peek, or a wake in flight
	// before the first frame lands), or after a run of failures a prior frame has gone stale; a lone
	// transient failure keeps the last frame so it does not flicker.
	val showOffSession =
		asleepIdle || (peekError != null && (frameEmpty || failCount >= 2)) || (wakeRequested && frameEmpty)

	Column(modifier) {
		when {
			showOffSession && !asleepIdle && peekError?.contains("user-launched") == true -> {
				// A user-launched session has no daemon pane to drive; that is an expected state, not a
				// failure, so it reads calm rather than alarming-red, with no wake affordance.
				Box(Modifier.weight(1f).fillMaxWidth().background(TERMINAL_BG), contentAlignment = Alignment.Center) {
					Text(
						peekError!!,
						Modifier.padding(24.dp),
						color = MaterialTheme.colorScheme.onSurfaceVariant,
						fontFamily = FontFamily.Monospace,
					)
				}
			}
			showOffSession -> {
				// The session is off (no container/pane) or its wake stalled. Offer an explicit Wake, or
				// Retry once one is in flight, rather than a silent bring-up.
				// Only [asleepIdle] has actually established that nothing is there. A peek that failed
				// says so instead, because calling an unreachable machine or a broken transport "asleep"
				// sends the owner to a Wake button for a session that may be running fine.
				Box(Modifier.weight(1f).fillMaxWidth().background(TERMINAL_BG), contentAlignment = Alignment.Center) {
					Column(
						horizontalAlignment = Alignment.CenterHorizontally,
						verticalArrangement = Arrangement.spacedBy(12.dp),
					) {
						Text(
							when {
								wakeRequested -> "Waking..."
								asleepIdle -> "This session is asleep."
								else -> peekError ?: "This session is asleep."
							},
							color = MaterialTheme.colorScheme.onSurfaceVariant,
							fontFamily = FontFamily.Monospace,
						)
						FilledTonalButton(onClick = hapticClick { wakeRequested = true; onWake() }) {
							Text(if (wakeRequested) "Retry" else "Wake")
						}
					}
				}
			}
			kind == "container-logs" -> {
				// Pre-pane: the devcontainer is still booting, so show its docker logs read-only (no
				// pane to type into yet). The pane replaces this the instant tmux comes up.
				Column(Modifier.weight(1f).fillMaxWidth()) {
					Text(
						"Container logs - waking",
						Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
						color = MaterialTheme.colorScheme.onSurfaceVariant,
						fontFamily = FontFamily.Monospace,
						fontSize = 11.sp,
					)
					TerminalPane(
						logs,
						paused = paused,
						onLongPress = { paused = true },
						onResume = { paused = false },
						modifier = Modifier.weight(1f).fillMaxWidth(),
					)
				}
			}
			frameEmpty -> {
				// Pre-first-frame (no error, no wake pending): a neutral placeholder rather than an
				// empty pane with a live-looking palette.
				Box(Modifier.weight(1f).fillMaxWidth().background(TERMINAL_BG), contentAlignment = Alignment.Center) {
					Text(
						"Connecting...",
						color = MaterialTheme.colorScheme.onSurfaceVariant,
						fontFamily = FontFamily.Monospace,
					)
				}
			}
			else -> {
				TerminalPane(
					ansi,
					paused = paused,
					onLongPress = { paused = true },
					onResume = { paused = false },
					modifier = Modifier.weight(1f).fillMaxWidth(),
				)
				if (sendError != null) {
					Text(
						sendError!!,
						Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
						color = MaterialTheme.colorScheme.error,
					)
				}
				if (limit != null) {
					// Outranks the slash macros deliberately: the session stays "online" while this dialog
					// holds the pane, so the macro row would otherwise still be showing, and tapping one
					// would type a slash command into a dialog whose keys pick menu options.
					Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
						Text(
							limit.detail?.let { "Session Limit hit · $it" } ?: "Session Limit hit",
							color = MaterialTheme.colorScheme.error,
							fontFamily = FontFamily.Monospace,
							fontSize = 12.sp,
						)
						FilledTonalButton(
							onClick = hapticClick {
								resuming = true
								scope.launch {
									runCatchingCancellable { onResumeAfterLimit() }
										.onFailure { sendError = it.message ?: "resume failed" }
									resuming = false
								}
							},
							enabled = !resuming,
							modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
						) {
							Text(if (resuming) "Resuming..." else "Resume")
						}
					}
				} else if (presence?.isOnline == true) {
					Row(
						Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
						horizontalArrangement = Arrangement.spacedBy(6.dp),
					) {
						PALETTE_SLASH.forEach { macro ->
							AssistChip(
								onClick = hapticClick {
									if (macro.autoSend) fire(macro.cmd, null) else input = "${macro.cmd} "
								},
								label = {
									Text(
										macro.cmd,
										fontFamily = FontFamily.Monospace,
										color = if (macro.autoSend) MACRO_AUTO_SEND_COLOR else MACRO_STAGE_ONLY_COLOR,
									)
								},
							)
						}
					}
				} else {
					// Claude is not running in this pane (Ctrl-C killed it, or the session is still coming
					// up), so the slash macros - claude TUI commands - have nothing to receive them. The row
					// becomes the relaunch affordance instead; the control keys and input stay, since the
					// bare shell underneath is still real and typeable.
					val waking = relaunching || presence?.isVerifying == true || presence?.waking(System.currentTimeMillis()) == true
					FilledTonalButton(
						onClick = hapticClick {
							relaunching = true
							wakeRequested = true
							scope.launch {
								runCatchingCancellable { onRelaunch() }.onFailure { sendError = it.message ?: "wake failed" }
								relaunching = false
							}
						},
						enabled = !waking,
						modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
					) {
						Text(if (waking) "Waking..." else "Wake up")
					}
				}
				Row(
					Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
					horizontalArrangement = Arrangement.spacedBy(6.dp),
				) {
					AssistChip(
						onClick = hapticClick { fire(null, "Escape") },
						label = { Text("Esc", fontFamily = FontFamily.Monospace) },
					)
					var ctrlMenuExpanded by remember { mutableStateOf(false) }
					Box {
						AssistChip(
							onClick = hapticClick { ctrlMenuExpanded = true },
							label = { Icon(Icons.Filled.KeyboardControlKey, contentDescription = "Ctrl / Shift modifiers") },
						)
						DropdownMenu(expanded = ctrlMenuExpanded, onDismissRequest = { ctrlMenuExpanded = false }) {
							CTRL_MENU_KEYS.forEach { (label, key) ->
								DropdownMenuItem(
									text = { Text(label, fontFamily = FontFamily.Monospace) },
									onClick = {
										ctrlMenuExpanded = false
										fire(null, key)
									},
								)
							}
						}
					}
					PALETTE_KEYS.drop(1).forEach { (label, key) ->
						AssistChip(
							onClick = hapticClick { fire(null, key) },
							label = { Text(label, fontFamily = FontFamily.Monospace) },
						)
					}
				}
				Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
					OutlinedTextField(
						value = input,
						onValueChange = { input = it },
						label = { Text("Type into the terminal") },
						minLines = 2,
						modifier = Modifier.weight(1f),
					)
					Column(
						Modifier.padding(start = 8.dp),
						// 40 + 5 + 40 spans the two-line field exactly, as in the chat composer.
						verticalArrangement = Arrangement.spacedBy(5.dp),
						horizontalAlignment = Alignment.CenterHorizontally,
					) {
						// Backspace sits directly above Send: a tap erases one char; press-and-hold
						// repeat-fires Alt+Backspace (delete-word) until release.
						BackspaceKey(
							onTap = { fire(null, "BSpace") },
							onHoldRepeat = { fire(null, "M-BSpace") },
						)
						// Empty box: a TAP submits a bare Enter. With text: a TAP stages it into the
						// composer WITHOUT Enter, and a LONG-PRESS types it AND submits. The icon flips
						// between a return-arrow (empty) and the Send plane (text) to signal which.
						SendKey(
							inputEmpty = input.isEmpty(),
							onTap = {
								if (input.isEmpty()) {
									fire(null, "Enter")
								} else {
									fire(input, null, submit = false)
									input = ""
								}
							},
							onLongPress = {
								if (input.isEmpty()) {
									fire(null, "Enter")
								} else {
									fire(input, null, submit = true)
									input = ""
								}
							},
						)
					}
				}
			}
		}
	}
}
