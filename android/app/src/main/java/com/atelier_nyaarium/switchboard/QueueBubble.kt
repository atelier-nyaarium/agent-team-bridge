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
	private var spinner: View? = null
	private var alertDot: View? = null

	/** Whether the overlay can be drawn at all. Without the grant the run still works and still shows
	 * in the shade - the bubble is an addition, never the only surface. */
	fun canShow(): Boolean = android.provider.Settings.canDrawOverlays(context)

	/**
	 * Draw the run.
	 *
	 * `count` and `generating` are INDEPENDENT facts, and drawn independently: the head is itself
	 * counted, so any rule that shows the spinner only at a count of zero never shows it at all.
	 */
	fun show(count: Int, generating: Boolean, failures: Int) {
		// Losing the grant takes the window away underneath us with no callback, so the remembered root
		// is detached and every later show would draw nothing. Dropped here, where the permission is
		// already being asked about, so a re-grant brings the bubble back rather than needing a restart.
		if (!canShow()) {
			release()
			return
		}
		if (dismissed) return
		val view = attached() ?: return
		// The count is what is left to SPEAK. In the failures-only state there is nothing left to speak,
		// and a "0" beside an alert dot reads as a broken badge rather than a finished run.
		countText?.text = if (count == 0) "!" else count.toString()
		spinner?.visibility = if (generating) View.VISIBLE else View.GONE
		alertDot?.visibility = if (failures > 0) View.VISIBLE else View.GONE
		view.visibility = View.VISIBLE
	}

	fun hide() {
		root?.visibility = View.GONE
	}

	// Swiped away by hand. Sticky, because the next playback event anywhere in the app republishes and
	// would otherwise put the bubble straight back - a dismissal that survives one event and no more is
	// not a dismissal. Cleared when a real run starts, which is the next thing worth interrupting for.
	private var dismissed = false

	fun dismiss() {
		dismissed = true
		hide()
	}

	fun undismiss() {
		dismissed = false
	}

	fun release() {
		root?.let { runCatching { windows.removeView(it) } }
		clear()
	}

	private fun clear() {
		root = null
		countText = null
		spinner = null
		alertDot = null
	}

	/**
	 * The attached root, building and adding it when there is not one.
	 *
	 * Null when the add FAILED, keeping nothing, so the next call tries again. A remembered view that
	 * was never attached is indistinguishable from a healthy bubble: every later show would set
	 * visibility on it and draw nothing, for the life of the service, while settings went on reporting
	 * the feature enabled. Revoking the grant takes the window away with no crash, and re-granting it
	 * has to bring the bubble back.
	 */
	private fun attached(): FrameLayout? {
		root?.let { return it }
		val view = build()
		val added = attach(view).also { if (!it) clear() }
		return if (added) view.also { root = it } else null
	}

	// Where the user last parked it, as an offset from vertical centre. Kept on the object rather than
	// in the params, so it survives the bubble being hidden between runs and re-shown - a badge that
	// jumped back to the middle every time would make moving it pointless.
	private var parkedY = 0

	private val layout = WindowManager.LayoutParams(
		WindowManager.LayoutParams.WRAP_CONTENT,
		WindowManager.LayoutParams.WRAP_CONTENT,
		WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
		// NOT_TOUCH_MODAL so touches outside the badge reach whatever is behind it: the bubble draws
		// over this app too, and without it a 48dp disc would eat taps on the app's own UI.
		WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
			WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
		android.graphics.PixelFormat.TRANSLUCENT,
	).apply {
		gravity = Gravity.END or Gravity.CENTER_VERTICAL
		x = dp(12)
	}

	private fun attach(view: FrameLayout): Boolean {
		layout.y = parkedY
		return runCatching { windows.addView(view, layout) }.isSuccess
	}

	/** Move the window itself, not the view inside it - a translated child would still be clipped to
	 * where the window is. Clamped to half the screen either way from centre, since the gravity is
	 * CENTER_VERTICAL, so it cannot be dragged off the top or bottom and become unreachable. */
	private fun moveTo(y: Int) {
		val view = root ?: return
		val limit = (context.resources.displayMetrics.heightPixels - dp(48)) / 2
		layout.y = y.coerceIn(-limit, limit)
		runCatching { windows.updateViewLayout(view, layout) }
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

		// Rides ALONGSIDE the count rather than replacing it, because "one left" and "that one is still
		// being made" are both true at once and the second is the slow one worth showing.
		val ring = android.widget.ProgressBar(context).apply {
			isIndeterminate = true
			visibility = View.GONE
		}
		spinner = ring

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
			// A RING around the badge, not a disc over it. Laid out in the badge's own bounds it covered
			// the count, so the one moment the spinner matters was the one moment the number vanished.
			addView(
				ring,
				FrameLayout.LayoutParams(dp(16), dp(16)).apply {
					gravity = Gravity.BOTTOM or Gravity.START
				},
			)
			addView(
				dot,
				FrameLayout.LayoutParams(dp(12), dp(12)).apply { gravity = Gravity.TOP or Gravity.END },
			)
			setOnTouchListener(
				SwipeAway(
					onTap = onTap,
					onSwipeAway = onSwipeAway,
					onDragY = { dy -> moveTo(parkedY + dy) },
					onDragEnd = { parkedY = layout.y },
					threshold = dp(56),
					slop = dp(16),
				),
			)
		}
	}

	private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()

	/**
	 * One touch, three meanings, decided by where the finger goes.
	 *
	 * A tap opens the queue. A HORIZONTAL drag past `threshold` skips or dismisses, the same action as
	 * the modal's trash. A VERTICAL drag moves the bubble out of the way and does nothing else - the
	 * badge sits over other apps, so being able to park it somewhere harmless matters more than any
	 * gesture that axis could otherwise carry.
	 *
	 * The axis is claimed once, on the first movement past `slop`, and held for the rest of the
	 * gesture. Deciding per-event instead would let a drifting drag flip mid-stroke and fire a skip at
	 * the end of what the user was doing as a move.
	 *
	 * A gesture that travels without earning either is NEITHER. Treating "did not swipe" as a tap
	 * turned an ordinary drag across the badge into an app launch.
	 */
	private class SwipeAway(
		private val onTap: () -> Unit,
		private val onSwipeAway: () -> Unit,
		private val onDragY: (Int) -> Unit,
		private val onDragEnd: () -> Unit,
		private val threshold: Int,
		private val slop: Int,
	) : View.OnTouchListener {
		private var startX = 0f
		private var startY = 0f
		private var travelled = 0f
		private var vertical: Boolean? = null

		override fun onTouch(view: View, event: MotionEvent): Boolean {
			when (event.actionMasked) {
				MotionEvent.ACTION_DOWN -> {
					startX = event.rawX
					startY = event.rawY
					travelled = 0f
					vertical = null
				}
				MotionEvent.ACTION_MOVE -> {
					val dx = event.rawX - startX
					val dy = event.rawY - startY
					travelled = maxOf(travelled, kotlin.math.hypot(dx, dy))
					if (vertical == null && travelled > slop) vertical = kotlin.math.abs(dy) > kotlin.math.abs(dx)
					if (vertical == true) onDragY(dy.toInt()) else view.translationX = dx
				}
				MotionEvent.ACTION_UP -> {
					val dx = event.rawX - startX
					view.translationX = 0f
					when {
						vertical == true -> onDragEnd()
						kotlin.math.abs(dx) > threshold -> onSwipeAway()
						travelled <= slop -> onTap()
					}
				}
				// A cancel means the gesture did NOT happen - the window went away underneath the finger,
				// or a parent took the stream. Firing the tap here opened the app when the run simply
				// ended while a finger was resting on the bubble. A move already applied is kept, since
				// the window really is where the drag left it.
				MotionEvent.ACTION_CANCEL -> {
					view.translationX = 0f
					if (vertical == true) onDragEnd()
				}
				else -> return false
			}
			return true
		}
	}
}
