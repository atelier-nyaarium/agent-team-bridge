package com.atelier_nyaarium.switchboard.vault

import androidx.fragment.app.FragmentActivity

/** The one owner-presence gate for vault approvals, reveals, and the setting that picks the policy. */
internal class ApprovalGate(
	private val policy: () -> String,
	private val persist: (String) -> Unit,
	private val authenticate: suspend (FragmentActivity?) -> Boolean,
	private val now: () -> Long = System::currentTimeMillis,
) {
	/** Null until a prompt passes. */
	@Volatile private var unlockedAt: Long? = null

	fun policy(): String = policy.invoke()

	/** Off passes; every prompts; window prompts once per 30 minutes. */
	suspend fun require(activity: FragmentActivity?): Boolean {
		val prompt = when (policy()) {
			VAULT_UNLOCK_EVERY -> true
			VAULT_UNLOCK_WINDOW -> unlockedAt?.let { now() - it > VAULT_UNLOCK_WINDOW_MS } ?: true
			else -> false
		}
		if (prompt && !authenticate(activity)) return false
		if (prompt) unlockedAt = now()
		return true
	}

	/** Tightening is free; loosening asks the owner; any change ends the window. */
	suspend fun changePolicy(value: String, activity: FragmentActivity?): Boolean {
		val current = policy()
		if (value == current) return true
		if (strength(value) < strength(current) && !authenticate(activity)) return false
		persist(value)
		unlockedAt = null
		return true
	}

	private fun strength(value: String): Int = when (value) {
		VAULT_UNLOCK_EVERY -> 2
		VAULT_UNLOCK_WINDOW -> 1
		else -> 0
	}
}
