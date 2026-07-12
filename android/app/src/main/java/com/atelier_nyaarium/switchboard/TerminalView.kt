package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.automirrored.filled.KeyboardReturn
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

////////////////////////////////
//  ANSI SGR rendering
//
//  Parsing is split into a PURE state machine (parseAnsiRuns, JVM-unit-testable with plain ARGB
//  longs) and the Compose adapter (ansiToAnnotated) that maps runs to colored spans.

// The standard + bright 16-color palette (VS Code's terminal theme) as ARGB longs.
private val ANSI_8 = longArrayOf(
	0xFF1E1E1E, 0xFFCD3131, 0xFF0DBC79, 0xFFE5E510, 0xFF2472C8, 0xFFBC3FBC, 0xFF11A8CD, 0xFFCCCCCC,
)
private val ANSI_BRIGHT = longArrayOf(
	0xFF666666, 0xFFF14C4C, 0xFF23D18B, 0xFFF5F543, 0xFF3B8EEA, 0xFFD670D6, 0xFF29B8DB, 0xFFFFFFFF,
)

private fun rgb(r: Int, g: Int, b: Int): Long =
	0xFF000000 or (r.toLong() shl 16) or (g.toLong() shl 8) or b.toLong()

/** The xterm 256-color index to an ARGB long (16 base, a 6x6x6 cube, then a grayscale ramp). */
private fun xterm256(n: Int): Long {
	if (n < 8) return ANSI_8[n]
	if (n < 16) return ANSI_BRIGHT[n - 8]
	if (n in 16..231) {
		val c = n - 16
		fun step(v: Int) = if (v == 0) 0 else 55 + v * 40
		return rgb(step(c / 36), step((c % 36) / 6), step(c % 6))
	}
	val v = 8 + (n - 232) * 10
	return rgb(v, v, v)
}

private const val ESC = '\u001b'
private const val BEL = '\u0007'

/** A styled run of text. A null color means "terminal default" (unspecified). `reverse` swaps
 * fg/bg at render time (SGR 7), which tmux status lines and selected rows rely on. */
internal data class AnsiRun(val text: String, val fg: Long?, val bg: Long?, val bold: Boolean, val reverse: Boolean)

/**
 * Parse a `tmux capture-pane -e` snapshot (text with SGR color escapes, no cursor motion) into
 * styled runs. Non-SGR escape sequences are skipped; unsupported SGR codes (italic, underline) are
 * ignored. Handles 16-color, 256-color, truecolor, bold, and reverse. Pure (no Compose), JVM-testable.
 */
internal fun parseAnsiRuns(input: String): List<AnsiRun> {
	val runs = ArrayList<AnsiRun>()
	var fg: Long? = null
	var bg: Long? = null
	var bold = false
	var reverse = false
	val buf = StringBuilder()

	fun flush() {
		if (buf.isEmpty()) return
		runs.add(AnsiRun(buf.toString(), fg, bg, bold, reverse))
		buf.setLength(0)
	}

	fun applySgr(p: List<Int>) {
		if (p.isEmpty()) {
			fg = null; bg = null; bold = false; reverse = false; return
		}
		var k = 0
		while (k < p.size) {
			when (val code = p[k]) {
				0 -> { fg = null; bg = null; bold = false; reverse = false }
				1 -> bold = true
				7 -> reverse = true
				22 -> bold = false
				27 -> reverse = false
				in 30..37 -> fg = ANSI_8[code - 30]
				in 90..97 -> fg = ANSI_BRIGHT[code - 90]
				39 -> fg = null
				in 40..47 -> bg = ANSI_8[code - 40]
				in 100..107 -> bg = ANSI_BRIGHT[code - 100]
				49 -> bg = null
				38, 48 -> {
					val isFg = code == 38
					when (p.getOrNull(k + 1)) {
						5 -> { val c = xterm256(p.getOrNull(k + 2) ?: 0); if (isFg) fg = c else bg = c; k += 2 }
						2 -> {
							val c = rgb(p.getOrNull(k + 2) ?: 0, p.getOrNull(k + 3) ?: 0, p.getOrNull(k + 4) ?: 0)
							if (isFg) fg = c else bg = c
							k += 4
						}
					}
				}
			}
			k++
		}
	}

	var i = 0
	val n = input.length
	while (i < n) {
		val c = input[i]
		if (c == '\u001b' && i + 1 < n && input[i + 1] == '[') {
			// Scan to the CSI final byte (0x40-0x7E); param/intermediate bytes are all below it.
			// Only 'm' (SGR) carries color; any other final byte (a non-SGR CSI) is skipped without
			// eating the char after it. capture-pane -e emits only SGR, so this is robustness.
			var j = i + 2
			while (j < n && input[j] < '@') j++
			if (j < n && input[j] == 'm') {
				flush()
				applySgr(input.substring(i + 2, j).split(';').mapNotNull { it.toIntOrNull() })
			}
			i = if (j < n) j + 1 else n
			continue
		}
		if (c == ESC && i + 1 < n && input[i + 1] == ']') {
			// OSC sequence (e.g. an OSC 8 hyperlink: ESC ] 8 ; params ; URI ST/BEL), terminated by
			// BEL (0x07) or ST (ESC \). Skip the whole sequence so its markup does not leak as text;
			// a hyperlink's visible label sits outside the sequence and stays.
			var j = i + 2
			while (j < n) {
				if (input[j] == BEL) { j++; break }
				if (input[j] == ESC && j + 1 < n && input[j + 1] == '\\') { j += 2; break }
				j++
			}
			i = j
			continue
		}
		if (c == '\u001b') { i++; continue }
		buf.append(c)
		i++
	}
	flush()
	return runs
}

// The pane's own default colors, used to resolve a null side when reverse must swap fg<->bg.
private const val DEFAULT_FG = 0xFFCCCCCCL
private const val DEFAULT_BG = 0xFF0C0C0CL

/** The Compose adapter: styled runs to a colored AnnotatedString. Reverse swaps fg/bg (resolving
 * a null side to the pane default) so it renders as a real highlight, not same-on-same text. */
fun ansiToAnnotated(input: String): AnnotatedString = buildAnnotatedString {
	for (r in parseAnsiRuns(input)) {
		val style = if (r.reverse) {
			SpanStyle(
				color = Color(r.bg ?: DEFAULT_BG),
				background = Color(r.fg ?: DEFAULT_FG),
				fontWeight = if (r.bold) FontWeight.Bold else null,
			)
		} else {
			SpanStyle(
				color = r.fg?.let { Color(it) } ?: Color.Unspecified,
				background = r.bg?.let { Color(it) } ?: Color.Unspecified,
				fontWeight = if (r.bold) FontWeight.Bold else null,
			)
		}
		withStyle(style) { append(r.text) }
	}
}

////////////////////////////////
//  Composables

private val TERMINAL_BG = Color(0xFF0C0C0C)

@Composable
private fun TerminalPane(
	ansi: String,
	paused: Boolean,
	onLongPress: () -> Unit,
	onResume: () -> Unit,
	modifier: Modifier = Modifier,
) {
	val annotated = remember(ansi) { ansiToAnnotated(ansi) }
	val body = @Composable {
		Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
			Text(
				text = annotated,
				modifier = Modifier.horizontalScroll(rememberScrollState()).padding(8.dp),
				fontFamily = FontFamily.Monospace,
				fontSize = 11.sp,
				lineHeight = 14.sp,
				color = Color(0xFFCCCCCC),
				softWrap = false,
			)
		}
	}
	Box(modifier.background(TERMINAL_BG)) {
		if (paused) {
			// Frozen frame, wrapped so text is selectable/copyable without the next peek wiping the
			// selection. A tapping the banner resumes live updates.
			SelectionContainer { body() }
			Surface(
				color = Color(0xCCD29922),
				shape = RoundedCornerShape(4.dp),
				modifier = Modifier.align(Alignment.TopEnd).padding(8.dp).hapticClickable(onClick = onResume),
			) {
				Text(
					"Paused - long-press to select, tap to resume",
					Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
					color = Color.Black,
					fontSize = 10.sp,
				)
			}
		} else {
			// Long-press freezes the frame and switches to the selectable view above.
			Box(Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures(onLongPress = { onLongPress() }) }) {
				body()
			}
		}
	}
}

// The fixed control-key palette: a label shown on the chip and the tmux key name sent.
private val PALETTE_KEYS = listOf(
	"Esc" to "Escape",
	"^C" to "C-c",
	"Tab" to "Tab",
	"Up" to "Up",
	"Down" to "Down",
	"Left" to "Left",
	"Right" to "Right",
)

// One-tap slash command macros for the agent's TUI. `autoSend` types the command with a trailing
// Enter (fires immediately); false stages it into the input box (with a trailing space) for the
// user to append to and submit manually, the same way /compact's optional trailing message works.
private data class SlashMacro(val cmd: String, val autoSend: Boolean)

private val PALETTE_SLASH = listOf(
	SlashMacro("/btw", autoSend = false),
	SlashMacro("/model", autoSend = true),
	SlashMacro("/effort", autoSend = true),
	SlashMacro("/usage", autoSend = true),
	SlashMacro("/context", autoSend = true),
	SlashMacro("/resume", autoSend = true),
	SlashMacro("/workflows", autoSend = true),
	SlashMacro("/compact", autoSend = false),
	SlashMacro("/mcp", autoSend = true),
	SlashMacro("/plugin", autoSend = true),
	SlashMacro("/reload-plugins", autoSend = true),
)

// Macro chip label color: orange fires Enter immediately, blue only stages text.
private val MACRO_AUTO_SEND_COLOR = Color(0xFFFF9800)
private val MACRO_STAGE_ONLY_COLOR = Color(0xFF2196F3)

// Backspace press-and-hold: the delay before a hold starts repeating, then the repeat cadence.
private const val BACKSPACE_HOLD_MS = 350L
private const val BACKSPACE_REPEAT_MS = 120L

/**
 * A filled key that fires `onTap` on a tap, and on press-and-hold starts repeat-firing `onHoldRepeat`
 * after a short threshold until release. Backspace uses it: a tap erases one char, a hold repeats
 * Alt+Backspace (delete-word).
 */
@Composable
private fun BackspaceKey(onTap: () -> Unit, onHoldRepeat: () -> Unit, modifier: Modifier = Modifier) {
	val scope = rememberCoroutineScope()
	val haptics = LocalHapticFeedback.current
	val strong = rememberStrongHaptic()
	Surface(
		shape = CircleShape,
		color = MaterialTheme.colorScheme.secondaryContainer,
		contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
		modifier = modifier
			.size(48.dp)
			.pointerInput(Unit) {
				awaitEachGesture {
					awaitFirstDown(requireUnconsumed = false)
					var repeated = false
					val job = scope.launch {
						delay(BACKSPACE_HOLD_MS)
						repeated = true
						strong()
						while (true) {
							onHoldRepeat()
							delay(BACKSPACE_REPEAT_MS)
						}
					}
					waitForUpOrCancellation()
					job.cancel()
					if (!repeated) {
						haptics.performHapticFeedback(HapticFeedbackType.LongPress)
						onTap()
					}
				}
			},
	) {
		Box(contentAlignment = Alignment.Center) {
			Icon(Icons.AutoMirrored.Filled.Backspace, contentDescription = "Backspace (hold to delete words)")
		}
	}
}

/**
 * The terminal Send control, behaving by whether the input box is empty:
 *  - EMPTY: a TAP submits a bare Enter (so you can fire Enter repeatedly); the icon is a return arrow.
 *  - WITH TEXT: a TAP types the text into the composer WITHOUT Enter (staged for review), a LONG-PRESS
 *    submits with Enter; the icon is the Send paper-plane.
 * The submit gestures get the firm buzz, staging gets the light tick. The pointerInput is keyed on
 * `inputEmpty` so the gesture closure always reflects the current emptiness. */
@Composable
private fun SendKey(inputEmpty: Boolean, onTap: () -> Unit, onLongPress: () -> Unit, modifier: Modifier = Modifier) {
	val haptics = LocalHapticFeedback.current
	val strong = rememberStrongHaptic()
	Surface(
		shape = CircleShape,
		color = MaterialTheme.colorScheme.primary,
		contentColor = MaterialTheme.colorScheme.onPrimary,
		modifier = modifier
			.size(48.dp)
			.pointerInput(inputEmpty) {
				detectTapGestures(
					// An empty-box tap IS the submit, so it gets the firm buzz; with text, a tap only
					// stages it (light tick). Long-press always submits (firm).
					onTap = {
						if (inputEmpty) strong() else haptics.performHapticFeedback(HapticFeedbackType.LongPress)
						onTap()
					},
					onLongPress = {
						strong()
						onLongPress()
					},
				)
			},
	) {
		Box(contentAlignment = Alignment.Center) {
			if (inputEmpty) {
				Icon(Icons.AutoMirrored.Filled.KeyboardReturn, contentDescription = "Submit (press Enter)")
			} else {
				Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send (tap to type, long-press to submit)")
			}
		}
	}
}

/**
 * The console terminal view. It always peeks; the render follows the peek result:
 *  - a live tmux pane (ANSI, auto-refreshed while RESUMED) with the control-key + slash palette and a
 *    text input that injects via tmux_send;
 *  - a read-only container-logs snapshot while the session's tmux pane does not exist yet (a booting
 *    devcontainer), with no input since there is nothing to type into;
 *  - a centered Wake button when the session is off (peek finds no container/pane), or "Waking..." +
 *    Retry once a wake has been asked for.
 * onPeek carries the last hash so an idle frame round-trips only the hash, and returns a Result so a
 * never-loaded pane can show the backend's reason instead of staying blank. `wakePending` seeds the
 * waking state for a session opened straight off a create/wake, so it reads "Waking..." not "asleep".
 */
@Composable
fun TerminalView(
	team: String,
	refreshMs: Long,
	wakePending: Boolean,
	sessionStatus: String?,
	onWake: () -> Unit,
	onPeek: suspend (sinceHash: String?) -> Result<ConsolePeekResult>,
	onSend: suspend (text: String?, key: String?, submit: Boolean) -> Unit,
	modifier: Modifier = Modifier,
) {
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
	var wakeRequested by remember(team) { mutableStateOf(wakePending) }
	// A long-press freezes the frame (this halts peeking) so its text can be selected and copied
	// without the next frame wiping the selection; the Paused banner resumes.
	var paused by remember(team) { mutableStateOf(false) }
	val scope = rememberCoroutineScope()
	val lifecycleOwner = LocalLifecycleOwner.current

	LaunchedEffect(team, refreshMs, sessionStatus) {
		lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
			while (true) {
				// A long-press pause freezes the frame; an asleep (available, not-yet-woken) session has
				// nothing to peek, so it idles on the Wake screen rather than docker-exec'ing a warm
				// container every cycle. A tap on Wake sets wakeRequested and the loop starts peeking.
				if (paused || (sessionStatus == "available" && !wakeRequested)) {
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
								}
							}
						}
						lastHash = r.hash
						peekError = null
						failCount = 0
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
	// pane can be peeked well before the Claude CLI inside it has started, so treating "a pane is
	// capturable" as "it is up" (the prior behavior) cleared the latch seconds into a warm-container
	// wake; the next transient peek hiccup during boot (a resize, a slow docker exec) then reopened the
	// off-session screen mislabeled as a fresh "This session is asleep." + "Wake" instead of "Waking...".
	LaunchedEffect(team, sessionStatus) {
		if (sessionStatus == "online") wakeRequested = false
	}

	fun fire(text: String?, key: String?, submit: Boolean = true) {
		scope.launch {
			sendError = null
			runCatching { onSend(text, key, submit) }.onFailure { sendError = it.message ?: "send failed" }
		}
	}

	val frameEmpty = ansi.isEmpty() && logs.isEmpty()
	// An asleep session (board says available) has not been woken, so it shows the Wake button even when
	// its container is still warm and a peek would return stale container-logs; only a session actually
	// coming up (verifying / wake requested) shows the live logs-then-pane.
	val asleepIdle = sessionStatus == "available" && !wakeRequested
	// The wake/error screen shows once there is no frame to display (a failed peek, or a wake in flight
	// before the first frame lands), or after a run of failures a prior frame has gone stale; a lone
	// transient failure keeps the last frame so it does not flicker.
	val showOffSession = asleepIdle || (peekError != null && (frameEmpty || failCount >= 2)) || (wakeRequested && frameEmpty)

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
				Box(Modifier.weight(1f).fillMaxWidth().background(TERMINAL_BG), contentAlignment = Alignment.Center) {
					Column(
						horizontalAlignment = Alignment.CenterHorizontally,
						verticalArrangement = Arrangement.spacedBy(12.dp),
					) {
						Text(
							if (wakeRequested) "Waking..." else "This session is asleep.",
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
				Row(
					Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
					horizontalArrangement = Arrangement.spacedBy(6.dp),
				) {
					PALETTE_KEYS.forEach { (label, key) ->
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
						modifier = Modifier.weight(1f),
					)
					Column(
						Modifier.padding(start = 8.dp),
						verticalArrangement = Arrangement.spacedBy(8.dp),
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
