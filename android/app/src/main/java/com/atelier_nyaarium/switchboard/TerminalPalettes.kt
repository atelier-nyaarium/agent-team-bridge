package com.atelier_nyaarium.switchboard

import androidx.compose.ui.graphics.Color

////////////////////////////////
//  Key and macro palettes

// The fixed control-key palette: a label shown on the chip and the tmux key name sent.
internal val PALETTE_KEYS = listOf(
	"Esc" to "Escape",
	"Tab" to "Tab",
	"Up" to "Up",
	"Down" to "Down",
	"Left" to "Left",
	"Right" to "Right",
	"Pg Up" to "PageUp",
	"Pg Down" to "PageDown",
)

// The modifier-combo menu the "Ctrl" chip opens, in place of a single fixed key: a label shown in
// the dropdown and the tmux key name sent.
internal val CTRL_MENU_KEYS = listOf(
	"Shift + Tab" to "BTab",
	"Ctrl + O" to "C-o",
	"Ctrl + T" to "C-t",
	"Ctrl + S" to "C-s",
	"Ctrl + C" to "C-c",
)

// One-tap slash command macros for the agent's TUI. `autoSend` types the command with a trailing
// Enter (fires immediately); false stages it into the input box (with a trailing space) for the
// user to append to and submit manually, the same way /compact's optional trailing message works.
internal data class SlashMacro(val cmd: String, val autoSend: Boolean)

internal val PALETTE_SLASH = listOf(
	SlashMacro("/btw", autoSend = false),
	SlashMacro("/model", autoSend = true),
	SlashMacro("/effort", autoSend = true),
	SlashMacro("/usage", autoSend = true),
	SlashMacro("/context", autoSend = true),
	SlashMacro("/workflows", autoSend = true),
	SlashMacro("/resume", autoSend = true),
	SlashMacro("/compact", autoSend = false),
	SlashMacro("/mcp", autoSend = true),
	SlashMacro("/plugin", autoSend = true),
	SlashMacro("/reload-plugins", autoSend = true),
)

// Macro chip label color: orange fires Enter immediately, blue only stages text.
internal val MACRO_AUTO_SEND_COLOR = Color(0xFFFF9800)
internal val MACRO_STAGE_ONLY_COLOR = Color(0xFF2196F3)
