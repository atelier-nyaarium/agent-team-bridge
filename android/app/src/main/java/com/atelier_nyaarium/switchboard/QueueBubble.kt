package com.atelier_nyaarium.switchboard

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView

/**
 * The floating count of what is still to be spoken, drawn over other apps.
 *
 * PLAIN VIEWS, not Compose. A `ComposeView` needs `ViewTreeLifecycleOwner`,
 * `ViewTreeSavedStateRegistryOwner` and `ViewTreeViewModelStoreOwner` on its root, and a Service is
 * none of the three - so Compose here means hand-rolling all three and keeping them correct across a
 * service restart, for a widget that draws two numbers and listens for a swipe.
 *
 * Shows only what it is told. It holds no idea of what is playing, so it cannot disagree with the
 * thread row or the lockscreen, which is the same rule those two follow.
 */
class QueueBubble(
	private val context: Context,
	private val onTap: () -> Unit,
	private val onSwipeAway: () -> Unit,
) {
	private val windows = context.getSystemService(WindowManager::class.java)
	private var root: FrameLayout? = null
	private var countText: TextView? = null
	private var alertDot: View? = null

	/** Whether the overlay can be drawn at all. Without the grant the run still works and still shows
	 * in the shade - the bubble is an addition, never the only surface. */
	fun canShow(): Boolean = android.provider.Settings.canDrawOverlays(context)

	fun show(count: Int, generating: Boolean, failures: Int) {
		if (!canShow()) return
		val view = root ?: build().also { root = it; attach(it) }
		countText?.text = if (generating && count == 0) "..." else count.toString()
		alertDot?.visibility = if (failures > 0) View.VISIBLE else View.GONE
		view.visibility = View.VISIBLE
	}

	fun hide() {
		root?.visibility = View.GONE
	}

	fun release() {
		root?.let { runCatching { windows.removeView(it) } }
		root = null
		countText = null
		alertDot = null
	}

	private fun attach(view: FrameLayout) {
		val params = WindowManager.LayoutParams(
			WindowManager.LayoutParams.WRAP_CONTENT,
			WindowManager.LayoutParams.WRAP_CONTENT,
			WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
			WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
			android.graphics.PixelFormat.TRANSLUCENT,
		).apply {
			gravity = Gravity.END or Gravity.CENTER_VERTICAL
			x = dp(12)
		}
		runCatching { windows.addView(view, params) }
	}

	private fun build(): FrameLayout {
		val size = dp(48)
		val badge = TextView(context).apply {
			gravity = Gravity.CENTER
			setTextColor(Color.WHITE)
			textSize = 16f
			background = GradientDrawable().apply {
				shape = GradientDrawable.OVAL
				setColor(Color.parseColor("#5B4B8A"))
			}
		}
		countText = badge

		// An ADDITIONAL badge rather than a replacement: a failure does not stop the run, so the count
		// still has to be readable while the alert is showing.
		val dot = View(context).apply {
			visibility = View.GONE
			background = GradientDrawable().apply {
				shape = GradientDrawable.OVAL
				setColor(Color.parseColor("#C5322A"))
			}
		}
		alertDot = dot

		return FrameLayout(context).apply {
			addView(badge, FrameLayout.LayoutParams(size, size))
			addView(
				dot,
				FrameLayout.LayoutParams(dp(12), dp(12)).apply { gravity = Gravity.TOP or Gravity.END },
			)
			setOnTouchListener(SwipeAway(onTap, onSwipeAway, dp(56)))
		}
	}

	private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()

	/**
	 * Tap versus swipe on one view. A tap opens the queue; a horizontal drag past the threshold
	 * dismisses the current entry and moves on, which is the same action as the modal's trash.
	 */
	private class SwipeAway(
		private val onTap: () -> Unit,
		private val onSwipeAway: () -> Unit,
		private val threshold: Int,
	) : View.OnTouchListener {
		private var startX = 0f
		private var moved = false

		override fun onTouch(view: View, event: MotionEvent): Boolean {
			when (event.actionMasked) {
				MotionEvent.ACTION_DOWN -> {
					startX = event.rawX
					moved = false
				}
				MotionEvent.ACTION_MOVE -> {
					val dx = event.rawX - startX
					if (kotlin.math.abs(dx) > threshold) moved = true
					view.translationX = dx
				}
				MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
					view.translationX = 0f
					if (moved) onSwipeAway() else onTap()
				}
				else -> return false
			}
			return true
		}
	}
}
