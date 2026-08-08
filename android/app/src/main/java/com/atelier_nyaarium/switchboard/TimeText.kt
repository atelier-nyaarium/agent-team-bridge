package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Functions & Helpers

/** Compact relative time for the session cards: now, 5m, 3h, 2d, else a date. */
internal fun relativeTime(at: Long): String {
	val delta = System.currentTimeMillis() - at
	return when {
		delta < 60_000 -> "now"
		delta < 3_600_000 -> "${delta / 60_000}m"
		delta < 86_400_000 -> "${delta / 3_600_000}h"
		delta < 604_800_000 -> "${delta / 86_400_000}d"
		else -> java.text.SimpleDateFormat("MMM d", java.util.Locale.getDefault()).format(java.util.Date(at))
	}
}

/** A scheduled send's remaining wait, coarsest unit first. Takes an already-computed remaining
 * duration, unlike [relativeTime], which is a time-since delta and reads nonsensically for a future
 * instant. Live-ish rather than truly ticking: the caller recomputes it roughly every minute. */
internal fun countdownText(remainingMs: Long): String {
	val totalMinutes = (remainingMs / 60_000L).coerceAtLeast(0L)
	return when {
		totalMinutes < 1 -> "in less than a minute"
		totalMinutes < 60 -> "in ${totalMinutes}m"
		totalMinutes < 1_440 -> "in ${totalMinutes / 60}h ${totalMinutes % 60}m"
		else -> "in ${totalMinutes / 1_440}d ${(totalMinutes % 1_440) / 60}h"
	}
}

/** A scheduled send's absolute fire time. Bare "HH:mm" when the fire date is today in the device's
 * own zone, else dated too, since a bare time would misread as today for a pick on another day. */
internal fun absoluteTimeText(atMillis: Long, zone: java.time.ZoneId): String {
	val at = java.time.Instant.ofEpochMilli(atMillis).atZone(zone)
	val time = "%02d:%02d".format(at.hour, at.minute)
	return if (at.toLocalDate() == java.time.LocalDate.now(zone)) {
		time
	} else {
		"${at.month.name.take(3).lowercase().replaceFirstChar { it.uppercase() }} ${at.dayOfMonth}, $time"
	}
}
