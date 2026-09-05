package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.gatewayOf

/** Under this the countdown reads in seconds and turns urgent. */
internal const val EXPIRY_SECONDS_BELOW_MS = 120_000L

/** A repeat of the same command inside this window after an answer is counted as a retry. */
internal const val REPEAT_WINDOW_MS = 90_000L

private const val SUDO_TRIES = 3

/** Machine, then the board's name for the session; the helper has no session. */
internal fun requester(state: ChatState, request: VaultPendingRequest): String {
	val gateway = runCatching { gatewayOf(request.team) }.getOrNull() ?: "?"
	return if (request.fromHelper) gateway else "$gateway · ${state.label(request.team)}"
}

/** The first token's basename. */
internal fun programOf(operation: String): String =
	operation.trim().split(Regex("\\s+")).firstOrNull()?.substringAfterLast('/') ?: ""

/** What is asked for: the entry, or the program asking for a password. */
internal fun requestTitle(request: VaultPendingRequest, entryTitle: String?): String {
	val entryId = request.entryId
	return when {
		entryId != null -> entryTitle ?: entryId
		programOf(request.operation) == "sudo" -> "Sudo request"
		else -> "Password request"
	}
}

internal data class Expiry(val text: String, val urgent: Boolean)

/** Whole minutes left; seconds, rounded up, under two minutes. */
internal fun expiresIn(deadlineAt: Long, now: Long = System.currentTimeMillis()): Expiry {
	val left = deadlineAt - now
	return when {
		left <= 0 -> Expiry("Expired", true)
		left < EXPIRY_SECONDS_BELOW_MS -> Expiry("Expires in ${(left + 999) / 1000} s", true)
		else -> Expiry("Expires in ${left / 60_000} min", false)
	}
}

/** A second ask under the same asker is a rejected value; without one, the same command soon after an answer is a guess. */
internal fun repeatNotice(request: VaultPendingRequest): String? {
	if (request.attempt <= 1) return null
	val sudo = programOf(request.operation) == "sudo"
	if (request.request.asker != null) {
		return if (sudo) "Wrong password. ${request.attempt} of $SUDO_TRIES." else "Not accepted. Try ${request.attempt}."
	}
	val since = request.sinceAnswerMs ?: return null
	val seconds = (since + 500) / 1000
	val tail = if (sudo) " Likely wrong password. ${request.attempt} of $SUDO_TRIES." else ""
	return "Asked again $seconds s after your answer.$tail"
}
