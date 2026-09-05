package com.atelier_nyaarium.switchboard.vault

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalGateTest {
	private var policy = VAULT_UNLOCK_OFF
	private var clock = 1_000_000L
	private var prompts = 0
	private var answer = true

	private fun gate() = ApprovalGate(
		policy = { policy },
		persist = { policy = it },
		authenticate = { prompts++; answer },
		now = { clock },
	)

	@Test
	fun offPassesEveryPromptsAndAWindowPromptsOncePerThirtyMinutes() = runBlocking {
		val gate = gate()
		assertTrue(gate.require(null))
		assertEquals(0, prompts)

		policy = VAULT_UNLOCK_EVERY
		assertTrue(gate.require(null))
		assertTrue(gate.require(null))
		assertEquals(2, prompts)

		// The prompt every-approval took a moment ago would still cover a window.
		clock += VAULT_UNLOCK_WINDOW_MS + 1
		policy = VAULT_UNLOCK_WINDOW
		assertTrue(gate.require(null))
		assertEquals(3, prompts)
		clock += VAULT_UNLOCK_WINDOW_MS - 1
		assertTrue(gate.require(null))
		assertEquals(3, prompts)
		clock += 2
		answer = false
		assertFalse(gate.require(null))
		assertEquals(4, prompts)
	}

	@Test
	fun tighteningIsFreeLooseningAsksAndAnyChangeEndsTheWindow() = runBlocking {
		val gate = gate()
		assertTrue(gate.changePolicy(VAULT_UNLOCK_WINDOW, null))
		assertTrue(gate.changePolicy(VAULT_UNLOCK_EVERY, null))
		assertEquals(0, prompts)
		assertEquals(VAULT_UNLOCK_EVERY, policy)

		answer = false
		assertFalse(gate.changePolicy(VAULT_UNLOCK_OFF, null))
		assertEquals(VAULT_UNLOCK_EVERY, policy)
		answer = true
		assertTrue(gate.changePolicy(VAULT_UNLOCK_WINDOW, null))
		assertEquals(2, prompts)

		// The window opened by a require does not survive a policy change.
		assertTrue(gate.require(null))
		assertEquals(3, prompts)
		assertTrue(gate.changePolicy(VAULT_UNLOCK_OFF, null))
		assertTrue(gate.changePolicy(VAULT_UNLOCK_WINDOW, null))
		assertTrue(gate.require(null))
		assertEquals(5, prompts)
	}
}
