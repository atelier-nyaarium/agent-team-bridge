package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What survives a projection fold that no longer carries a row.
 *
 * The defect this pins: every row from a Gateway other than the home one was held forever, so a
 * session the Router had genuinely dropped kept drawing and no forget could remove it while the
 * app lived. The roster is what says which Gateways the projection speaks for.
 */
class PresenceMergeTest {
	private val home = "sakura"
	private val domain = "dom1"
	private val roster = setOf("sakura", "mikan")

	private fun row(gateway: String, session: String, rowDomain: String? = domain) =
		testTeam(name = "$rowDomain.$gateway.host.$session", domainId = rowDomain)

	@Test
	fun `a forgotten peer session is swept once its Gateway is in the roster`() {
		val gone = row("mikan", "c2fe43")
		assertFalse(keepPriorRow(gone, home, domain, roster))
	}

	@Test
	fun `a home session absent from the projection is swept`() {
		assertFalse(keepPriorRow(row("sakura", "82d560"), home, domain, roster))
	}

	@Test
	fun `a linked friend Domain keeps its rows, since this projection never carried them`() {
		val friend = row("elderberry", "aa11", rowDomain = "dom2")
		assertTrue(keepPriorRow(friend, home, domain, roster))
	}

	@Test
	fun `a Gateway the roster does not name keeps its rows`() {
		assertTrue(keepPriorRow(row("yuzu", "bb22"), home, domain, roster))
	}

	@Test
	fun `an empty projection still sweeps a rostered Gateway's rows`() {
		// planeDomain is null when the projection carries no rows at all.
		assertFalse(keepPriorRow(row("mikan", "c2fe43"), home, null, roster))
		assertTrue(keepPriorRow(row("yuzu", "bb22"), home, null, roster))
	}

	@Test
	fun `merge keeps a fresh row over the prior one and drops what the rule refuses`() {
		val prior = listOf(row("mikan", "c2fe43"), row("mikan", "01f24f"), row("yuzu", "bb22"))
		val fresh = listOf(row("mikan", "01f24f"))
		val merged = mergePresence(prior, fresh) { keepPriorRow(it, home, domain, roster) }
		assertEquals(listOf("$domain.mikan.host.01f24f", "$domain.yuzu.host.bb22"), merged.map { it.name })
	}
}
