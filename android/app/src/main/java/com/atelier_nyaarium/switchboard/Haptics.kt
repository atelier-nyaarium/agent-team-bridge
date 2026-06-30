package com.atelier_nyaarium.switchboard

import android.content.Context
import android.os.VibrationEffect
import android.os.VibratorManager
import androidx.compose.foundation.clickable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback

////////////////////////////////
//  Haptics
//
//  Two tiers. The LIGHT per-tap tick (hapticClick / hapticClickable) routes through Compose's
//  performHapticFeedback, which respects the system touch-feedback setting and needs no permission.
//  The STRONG buzz (rememberStrongHaptic) is for the consequential gestures - the long-press submit,
//  hold-to-delete-word, a session long-press - and uses the predefined HEAVY_CLICK vibration so a
//  commit feels distinctly firmer than a tap. LongPress is used for the light tier because the
//  lighter Compose constant (TextHandleMove) is suppressed or imperceptible on many devices.

/** Wrap a click handler so it fires the LIGHT haptic tick before running: `onClick = hapticClick { ... }`. */
@Composable
fun hapticClick(onClick: () -> Unit): () -> Unit {
	val haptics = LocalHapticFeedback.current
	return {
		haptics.performHapticFeedback(HapticFeedbackType.LongPress)
		onClick()
	}
}

/** A firmer one-shot for the consequential gestures (submit, hold-to-delete, long-press). Returns a
 * callable that fires the predefined HEAVY_CLICK so a commit reads as heavier than the light per-tap
 * tick. minSdk 33, so VibratorManager + createPredefined are always available. */
@Composable
fun rememberStrongHaptic(): () -> Unit {
	val context = LocalContext.current
	val vibrator =
		remember(context) {
			(context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
		}
	return { vibrator.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK)) }
}

/** `Modifier.clickable` plus the same haptic tick, for clickable rows/boxes that are not Material
 * buttons (those take an onClick lambda `hapticClick` wraps directly). */
fun Modifier.hapticClickable(onClick: () -> Unit): Modifier =
	composed {
		val haptics = LocalHapticFeedback.current
		clickable {
			haptics.performHapticFeedback(HapticFeedbackType.LongPress)
			onClick()
		}
	}
