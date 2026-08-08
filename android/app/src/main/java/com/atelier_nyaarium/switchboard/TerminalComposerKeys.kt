package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.automirrored.filled.KeyboardReturn
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

////////////////////////////////
//  Composer input keys

// Backspace press-and-hold: the delay before a hold starts repeating, then the repeat cadence.
private const val BACKSPACE_HOLD_MS = 350L
private const val BACKSPACE_REPEAT_MS = 120L

/**
 * A filled key that fires `onTap` on a tap, and on press-and-hold starts repeat-firing `onHoldRepeat`
 * after a short threshold until release. Backspace uses it: a tap erases one char, a hold repeats
 * Alt+Backspace (delete-word).
 */
@Composable
internal fun BackspaceKey(onTap: () -> Unit, onHoldRepeat: () -> Unit, modifier: Modifier = Modifier) {
	val scope = rememberCoroutineScope()
	val haptics = LocalHapticFeedback.current
	val strong = rememberStrongHaptic()
	Surface(
		shape = RoundedCornerShape(8.dp),
		color = MaterialTheme.colorScheme.secondaryContainer,
		contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
		modifier = modifier
			.size(width = 56.dp, height = 40.dp)
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
internal fun SendKey(inputEmpty: Boolean, onTap: () -> Unit, onLongPress: () -> Unit, modifier: Modifier = Modifier) {
	val haptics = LocalHapticFeedback.current
	val strong = rememberStrongHaptic()
	Surface(
		shape = RoundedCornerShape(8.dp),
		color = MaterialTheme.colorScheme.primary,
		contentColor = MaterialTheme.colorScheme.onPrimary,
		modifier = modifier
			.size(width = 56.dp, height = 40.dp)
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
