package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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

/** A styled run of text. A null color means "terminal default" (unspecified). `reverse` swaps
 * fg/bg at render time (SGR 7), which tmux status lines and selected rows rely on. */
internal data class AnsiRun(val text: String, val fg: Long?, val bg: Long?, val bold: Boolean, val reverse: Boolean)

/**
 * Parse a `tmux capture-pane -e` snapshot (text with SGR color escapes, no cursor motion) into
 * styled runs. Non-SGR escape sequences are skipped; unsupported SGR codes (italic, underline) are
 * ignored. v1 scope: 16-color, 256-color, truecolor, bold, reverse. Pure (no Compose), JVM-testable.
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
private fun TerminalPane(ansi: String, modifier: Modifier = Modifier) {
	val annotated = remember(ansi) { ansiToAnnotated(ansi) }
	Column(modifier.background(TERMINAL_BG).verticalScroll(rememberScrollState())) {
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

// The fixed control-key palette: a label shown on the chip and the tmux key name sent.
private val PALETTE_KEYS = listOf(
	"Enter" to "Enter",
	"Esc" to "Escape",
	"^C" to "C-c",
	"Tab" to "Tab",
	"Up" to "Up",
	"Down" to "Down",
	"Left" to "Left",
	"Right" to "Right",
)

// One-tap curated text (sent as literal text + Enter), for the common prompt answers.
private val PALETTE_TEXT = listOf("y", "n")

/**
 * The terminal view: a live ANSI pane (auto-refreshed while the screen is RESUMED, so it pauses on
 * background and when toggled off) over a fixed palette (control keys + curated text) + a text input
 * that injects via tmux_send. onPeek carries the last hash so an idle pane round-trips only the hash,
 * and returns a Result so a never-loaded pane can show the backend's reason instead of staying blank.
 */
@Composable
fun TerminalView(
	team: String,
	refreshMs: Long,
	onPeek: suspend (sinceHash: String?) -> Result<ConsolePeekResult>,
	onSend: suspend (text: String?, key: String?) -> Unit,
	modifier: Modifier = Modifier,
) {
	var ansi by remember(team) { mutableStateOf("") }
	var lastHash by remember(team) { mutableStateOf<String?>(null) }
	var input by remember(team) { mutableStateOf("") }
	var sendError by remember(team) { mutableStateOf<String?>(null) }
	var peekError by remember(team) { mutableStateOf<String?>(null) }
	val scope = rememberCoroutineScope()
	val lifecycleOwner = LocalLifecycleOwner.current

	LaunchedEffect(team, refreshMs) {
		lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
			while (true) {
				onPeek(lastHash)
					.onSuccess { r ->
						if (r.unchanged != true && r.ansi != null) ansi = r.ansi
						lastHash = r.hash
						peekError = null
					}
					// Surface a failure only before any frame has loaded; once a frame is up, a
					// transient blip keeps the last frame so the pane does not flicker.
					.onFailure { if (ansi.isEmpty()) peekError = it.message ?: "terminal unavailable" }
				delay(refreshMs)
			}
		}
	}

	fun fire(text: String?, key: String?) {
		scope.launch {
			sendError = null
			runCatching { onSend(text, key) }.onFailure { sendError = it.message ?: "send failed" }
		}
	}

	Column(modifier) {
		if (ansi.isEmpty() && peekError != null) {
			Box(Modifier.weight(1f).fillMaxWidth().background(TERMINAL_BG), contentAlignment = Alignment.Center) {
				Text(peekError!!, Modifier.padding(24.dp), color = MaterialTheme.colorScheme.error, fontFamily = FontFamily.Monospace)
			}
		} else {
			TerminalPane(ansi, Modifier.weight(1f).fillMaxWidth())
		}
		if (sendError != null) {
			Text(sendError!!, Modifier.padding(horizontal = 12.dp, vertical = 2.dp), color = MaterialTheme.colorScheme.error)
		}
		Row(
			Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
			horizontalArrangement = Arrangement.spacedBy(6.dp),
		) {
			PALETTE_KEYS.forEach { (label, key) ->
				AssistChip(onClick = { fire(null, key) }, label = { Text(label, fontFamily = FontFamily.Monospace) })
			}
			PALETTE_TEXT.forEach { t ->
				AssistChip(onClick = { fire(t, null) }, label = { Text(t, fontFamily = FontFamily.Monospace) })
			}
		}
		Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
			OutlinedTextField(
				value = input,
				onValueChange = { input = it },
				label = { Text("Type into the terminal") },
				modifier = Modifier.weight(1f),
			)
			FilledIconButton(
				enabled = input.isNotEmpty(),
				onClick = {
					fire(input, null)
					input = ""
				},
				modifier = Modifier.padding(start = 8.dp).widthIn(min = 48.dp),
			) {
				Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send to terminal")
			}
		}
	}
}
