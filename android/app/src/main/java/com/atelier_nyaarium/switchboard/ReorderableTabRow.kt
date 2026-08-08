package com.atelier_nyaarium.switchboard

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import kotlin.math.roundToInt
import kotlinx.coroutines.withTimeoutOrNull

////////////////////////////////
//  Composables

/**
 * Session tabs: tap selects, hold still past the long-press timeout to lift the tab into a drag,
 * with no separate handle.
 *
 * The whole gesture lives in ONE pointerInput detector per tab, because two detectors sharing a node
 * fight each other: a click handler's own press tracking reacts to movement during the long-press
 * wait and cancels the drag arm on real touch hardware. Cooperation with the row's horizontalScroll
 * is by consumption. During the wait nothing is consumed, so a swipe scrolls exactly as before; once
 * latched every change is consumed, so the scrollable can never steal the drag.
 *
 * The held tab lifts as a ghost through graphicsLayer translation only, never layout, so the visual
 * shifts cannot feed back into the geometry. That geometry is pure math in TabDragMath.kt.
 */
@Composable
internal fun ReorderableTabRow(
	tabs: List<String>,
	selected: String,
	tabLabel: (String) -> String,
	onSelect: (String) -> Unit,
	onReorder: (List<String>) -> Unit,
) {
	val strong = rememberStrongHaptic()
	val haptics = LocalHapticFeedback.current
	val density = LocalDensity.current
	val scrollState = rememberScrollState()
	val tabsNow = rememberUpdatedState(tabs)
	val onSelectNow = rememberUpdatedState(onSelect)
	val onReorderNow = rememberUpdatedState(onReorder)

	var draggingTab by remember { mutableStateOf<String?>(null) }
	var dragDeltaX by remember { mutableFloatStateOf(0f) }
	var scrollStart by remember { mutableIntStateOf(0) }
	var viewportW by remember { mutableIntStateOf(0) }
	val bounds = remember { mutableStateMapOf<String, TabSlot>() }
	val gapPx = with(density) { 4.dp.toPx() }

	// Insertion index of the ghost's current position (-1 while not dragging or before layout). The
	// scroll term keeps it correct during edge auto-scroll, when content moves under a stationary
	// finger without any pointer event firing.
	val targetK by remember(tabs) {
		derivedStateOf {
			val t = draggingTab ?: return@derivedStateOf -1
			val from = tabs.indexOf(t)
			if (from < 0) return@derivedStateOf -1
			val slots = tabs.map { bounds[it] ?: return@derivedStateOf -1 }
			val ghostCenter = slots[from].x + slots[from].width / 2f + dragDeltaX + (scrollState.value - scrollStart)
			tabInsertionIndex(slots, from, ghostCenter)
		}
	}

	// A light tick each time the landing slot moves; the lift itself already fired the strong buzz.
	LaunchedEffect(draggingTab) {
		if (draggingTab == null) return@LaunchedEffect
		var last = Int.MIN_VALUE
		snapshotFlow { targetK }.collect { k ->
			if (k >= 0) {
				if (last != Int.MIN_VALUE && k != last) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
				last = k
			}
		}
	}

	// Edge auto-scroll so a drag can travel beyond the visible tabs. The finger's viewport position
	// is scroll-invariant while held at an edge, since content position and scroll delta cancel.
	LaunchedEffect(draggingTab) {
		val t = draggingTab ?: return@LaunchedEffect
		val edgePx = with(density) { 48.dp.toPx() }
		val stepPx = with(density) { 8.dp.toPx() }
		while (true) {
			withFrameNanos {}
			val slot = bounds[t] ?: continue
			if (viewportW <= 0) continue
			val screenX = slot.x + slot.width / 2f + dragDeltaX - scrollStart
			val fromLeft = screenX
			val fromRight = viewportW - screenX
			when {
				fromLeft < edgePx -> scrollState.scrollBy(-stepPx * (1f - (fromLeft / edgePx).coerceAtLeast(0f)))
				fromRight < edgePx -> scrollState.scrollBy(stepPx * (1f - (fromRight / edgePx).coerceAtLeast(0f)))
			}
		}
	}

	Box(
		Modifier
			.onGloballyPositioned { viewportW = it.size.width }
			.horizontalScroll(scrollState)
			.padding(horizontal = 8.dp, vertical = 4.dp),
	) {
		// Landing-slot highlight, behind the tabs (Box children draw in order).
		val dragged = draggingTab
		if (dragged != null && targetK >= 0) {
			val slots = tabs.mapNotNull { bounds[it] }
			val from = tabs.indexOf(dragged)
			if (slots.size == tabs.size && from >= 0) {
				val slot = slots[from]
				val gapX = tabGapLeftEdge(slots, from, targetK, gapPx)
				Box(
					Modifier
						.offset { IntOffset(gapX.roundToInt(), slot.y.roundToInt()) }
						.size(with(density) { slot.width.toDp() }, with(density) { slot.height.toDp() })
						.clip(RoundedCornerShape(8.dp))
						.background(MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.35f)),
				)
			}
		}
		Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
			tabs.forEach { t ->
				key(t) {
					val isSelected = t == selected
					val isDragging = t == draggingTab
					val shiftTarget =
						if (draggingTab != null && !isDragging && targetK >= 0) {
							val from = tabs.indexOf(draggingTab)
							val span = (bounds[draggingTab]?.width ?: 0f) + gapPx
							if (from >= 0) tabShift(tabs.indexOf(t), from, targetK, span) else 0f
						} else {
							0f
						}
					// Snap rather than animate back once the drag ends: the committed order already
					// moved the layout, so a lingering animated shift would double it.
					val shift by animateFloatAsState(
						targetValue = shiftTarget,
						animationSpec = if (draggingTab != null) spring() else snap(),
						label = "tabShift",
					)
					Box(
						modifier = Modifier
							.onGloballyPositioned { c ->
								val p = c.positionInParent()
								bounds[t] = TabSlot(p.x, p.y, c.size.width.toFloat(), c.size.height.toFloat())
							}
							.zIndex(if (isDragging) 1f else 0f)
							.graphicsLayer {
								if (isDragging) {
									translationX = dragDeltaX + (scrollState.value - scrollStart)
									translationY = -24.dp.toPx()
									scaleX = 1.05f
									scaleY = 1.05f
									shadowElevation = 6.dp.toPx()
									shape = RoundedCornerShape(8.dp)
									clip = true
								} else {
									translationX = shift
								}
							}
							.clip(RoundedCornerShape(8.dp))
							.background(
								if (isDragging || isSelected) {
									MaterialTheme.colorScheme.secondaryContainer
								} else {
									Color.Transparent
								},
							)
							.pointerInput(t) {
								awaitEachGesture {
									val down = awaitFirstDown()
									// true = released early without moving (a tap); false = movement past
									// slop or an external consume (the row scroll) took the gesture;
									// null = held still through the timeout (lift into drag).
									val tapped =
										withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
											var acc = Offset.Zero
											var result: Boolean? = null
											while (result == null) {
												val event = awaitPointerEvent()
												val ch = event.changes.firstOrNull { it.id == down.id } ?: continue
												when {
													!ch.pressed -> result = acc.getDistance() <= viewConfiguration.touchSlop
													ch.isConsumed -> result = false
													else -> {
														acc += ch.positionChange()
														if (acc.getDistance() > viewConfiguration.touchSlop) result = false
													}
												}
											}
											result
										}
									when (tapped) {
										true -> {
											haptics.performHapticFeedback(HapticFeedbackType.LongPress)
											onSelectNow.value(t)
										}
										false -> {}
										null -> {
											strong()
											draggingTab = t
											dragDeltaX = 0f
											scrollStart = scrollState.value
											try {
												while (true) {
													val event = awaitPointerEvent()
													val ch = event.changes.firstOrNull { it.id == down.id } ?: continue
													if (!ch.pressed) {
														ch.consume()
														val now = tabsNow.value
														val k = targetK
														val from = now.indexOf(t)
														if (k >= 0 && from >= 0) {
															val next = tabCommitOrder(now, from, k)
															if (next != now) onReorderNow.value(next)
														}
														break
													}
													dragDeltaX += ch.positionChange().x
													ch.consume()
												}
											} finally {
												draggingTab = null
												dragDeltaX = 0f
											}
										}
									}
								}
							}
							.padding(horizontal = 12.dp, vertical = 8.dp),
					) {
						Text(
							tabLabel(t),
							color = if (isSelected) {
								MaterialTheme.colorScheme.onSecondaryContainer
							} else {
								MaterialTheme.colorScheme.onSurfaceVariant
							},
							style = MaterialTheme.typography.labelLarge,
						)
					}
				}
			}
		}
	}
}
