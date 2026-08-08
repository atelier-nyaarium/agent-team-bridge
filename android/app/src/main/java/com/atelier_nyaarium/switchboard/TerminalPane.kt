package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

////////////////////////////////
//  Terminal pane

internal val TERMINAL_BG = Color(0xFF0C0C0C)

@Composable
internal fun TerminalPane(
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
