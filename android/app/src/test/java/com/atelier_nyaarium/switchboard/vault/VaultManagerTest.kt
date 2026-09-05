package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.VAULT_GATEWAYS_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PRIVATE_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PUBLIC_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_VALUE_KIND
import com.atelier_nyaarium.switchboard.proto.VaultEntryClear
import com.atelier_nyaarium.switchboard.proto.VaultEntrySealed
import com.atelier_nyaarium.switchboard.proto.VaultListResult
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import com.atelier_nyaarium.switchboard.testAmbient
import com.atelier_nyaarium.switchboard.testBootstrap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VaultManagerTest {
	private class FakeStore(private var blob: String? = null) : VaultStore {
		override fun loadVault(): String? = blob

		override fun saveVault(json: String) {
			blob = json
		}
	}

	private val owner = Crypto.generateIdentity()
	private val domainId = "domain"
	private val keyring = ContentKeyring().also { it.deriveOwned(owner, domainId, 1) }

	private fun sealing(ring: ContentKeyring = keyring) = VaultSealing(
		testBootstrap(domainId = domainId, owner = owner, contentKeyring = ring),
		testAmbient(nonceBytes = ByteArray(12) { 1 }),
	) {}

	private fun entry(
		id: String,
		revision: Long = 1L,
		changedAt: Long = revision,
		tombstone: Boolean = false,
		sealed: VaultEntrySealed = VaultEntrySealed(publicTitle = sealing().seal("Title $id", VAULT_PUBLIC_TITLE_KIND, id)),
	) = VaultStoredEntry(VaultEntryClear(id, revision, tombstone, changedAt, "phone", 10L, 20L), sealed)

	private fun list(revision: Long, since: Long, vararg entries: VaultStoredEntry) =
		VaultListResult(revision, since, entries.toList())

	private fun entryRequest(id: String, deadlineAt: Long, entryId: String = "e1"): VaultRequest =
		VaultRequest.Entry(entryId, 1L, id, "ssh deploy@prod", "ssh deploy@prod", "host.alice", deadlineAt)

	private fun typedRequest(id: String, deadlineAt: Long): VaultRequest =
		VaultRequest.Typed(1L, id, "sudo apt install foo", "sudo apt", "helper.abc", deadlineAt)

	@Test
	fun aFullListReplacesAndADeltaMergesWhileTombstonesHide() {
		val vault = VaultManager(FakeStore())
		assertTrue(vault.applyList(list(2L, 0L, entry("a"), entry("b", revision = 1L, changedAt = 2L))))
		assertEquals(listOf("a", "b"), vault.live().map { it.clear.id })
		assertEquals(2L, vault.routerRevision)

		assertTrue(vault.applyList(list(4L, 2L, entry("b", revision = 2L, changedAt = 3L, tombstone = true), entry("c", changedAt = 4L))))
		assertEquals(listOf("a", "c"), vault.live().map { it.clear.id })
		assertNull(vault.stored("b"))
		assertEquals(4L, vault.routerRevision)

		// A full list drops what it no longer names.
		assertTrue(vault.applyList(list(5L, 0L, entry("c", changedAt = 5L))))
		assertEquals(listOf("c"), vault.live().map { it.clear.id })
	}

	@Test
	fun aRouterThatFellBehindAsksForAFullListNext() {
		val vault = VaultManager(FakeStore())
		vault.applyList(list(9L, 0L, entry("a")))
		assertFalse(vault.applyList(list(3L, 9L)))
		assertEquals(0L, vault.routerRevision)
		assertEquals(listOf("a"), vault.live().map { it.clear.id })
	}

	@Test
	fun aWriteLandsItsEntryAndAdvancesOnlyWhenNothingWasSkipped() {
		val vault = VaultManager(FakeStore())
		vault.applyList(list(2L, 0L, entry("a")))
		vault.applyWrite(entry("b", changedAt = 3L), 3L)
		assertEquals(3L, vault.routerRevision)
		// Another phone wrote revision 4 first.
		vault.applyWrite(entry("c", changedAt = 5L), 5L)
		assertEquals(3L, vault.routerRevision)
		assertEquals(listOf("a", "b", "c"), vault.live().map { it.clear.id })
	}

	@Test
	fun aLateAnswerNeverRollsBackWhatADeltaAlreadyLanded() {
		val vault = VaultManager(FakeStore())
		vault.applyList(list(1L, 0L, entry("a")))
		vault.applyList(list(3L, 1L, entry("a", revision = 3L, changedAt = 3L)))
		// The phone's own write at revision 2 answers after the delta that superseded it.
		vault.applyWrite(entry("a", revision = 2L, changedAt = 2L), 2L)
		assertEquals(3L, vault.stored("a")!!.clear.revision)
		// A full list older than the held revision is a late answer too.
		assertFalse(vault.applyList(list(2L, 0L, entry("a", revision = 2L, changedAt = 2L))))
		assertEquals(3L, vault.routerRevision)
	}

	@Test
	fun workBegunBeforeAWipeLandsNothingAfterIt() {
		val vault = VaultManager(FakeStore())
		val generation = vault.generation
		vault.addRequest("dom.gw.host.alice", entryRequest("r1", 10_000L), now = 1_000L)
		vault.wipe()
		assertFalse(vault.applyList(list(1L, 0L, entry("a")), generation = generation))
		vault.applyWrite(entry("b"), 1L, generation = generation)
		assertTrue(vault.live().isEmpty())
		assertTrue(vault.pending.value.isEmpty())
		assertTrue(vault.applyList(list(1L, 0L, entry("a"))))
		vault.addRequest("dom.gw.host.alice", entryRequest("r2", 10_000L), now = 1_000L)
		vault.clearRequests()
		assertTrue(vault.pending.value.isEmpty())
	}

	@Test
	fun viewsOpenEveryFieldButTheValueAndFlagAScopeThisPhoneCannotRead() {
		val vault = VaultManager(FakeStore())
		val open = sealing()
		val sealed = VaultEntrySealed(
			publicTitle = open.seal("Deploy key", VAULT_PUBLIC_TITLE_KIND, "k"),
			privateTitle = open.seal("prod deploy", VAULT_PRIVATE_TITLE_KIND, "k"),
			value = open.seal("hunter2", VAULT_VALUE_KIND, "k"),
			gateways = open.seal("[\"laptop\",\"desk\"]", VAULT_GATEWAYS_KIND, "k"),
		)
		vault.applyList(list(1L, 0L, entry("k", sealed = sealed)))
		val view = vault.views(open).single()
		assertEquals("prod deploy", view.title)
		assertEquals("Deploy key", view.publicTitle)
		assertEquals(listOf("laptop", "desk"), view.gateways)
		assertTrue(view.hasValue)
		assertTrue(view.matches("DEPLOY"))
		assertEquals("hunter2", vault.openValue(vault.stored("k")!!, open))

		val stranger = sealing(ContentKeyring().also { it.deriveOwned(Crypto.generateIdentity(), domainId, 1) })
		val blind = vault.view(vault.stored("k")!!, stranger)
		assertNull(blind.publicTitle)
		assertTrue(blind.gatewaysUnreadable)
		assertEquals("k", blind.title)
	}

	@Test
	fun requestsDedupeExpireSettleAndFollowTheirThread() {
		val vault = VaultManager(FakeStore())
		assertTrue(vault.addRequest("dom.gw.host.alice", entryRequest("r1", 10_000L), now = 1_000L))
		assertFalse(vault.addRequest("dom.gw.host.alice", entryRequest("r1", 10_000L), now = 1_000L))
		assertFalse(vault.addRequest("dom.gw.host.alice", entryRequest("late", 900L), now = 1_000L))
		assertTrue(vault.addRequest("dom.gw.owner.claude", typedRequest("r2", 5_000L), now = 1_000L))
		assertEquals(listOf("r1", "r2"), vault.pending.value.map { it.requestId })
		assertTrue(vault.request("r2")!!.fromHelper)

		assertTrue(vault.sweepRequests(now = 6_000L))
		assertEquals(listOf("r1"), vault.pending.value.map { it.requestId })
		vault.settleRequest("r1")
		assertTrue(vault.pending.value.isEmpty())

		vault.addRequest("dom.gw.host.bob", entryRequest("r3", 10_000L), now = 1_000L)
		vault.forgetTeam("dom.gw.host.bob")
		assertTrue(vault.pending.value.isEmpty())
	}

	@Test
	fun aRepeatSoonAfterAnAnswerCountsItsAttemptAndAnOldOneDoesNot() {
		val vault = VaultManager(FakeStore())
		val team = "dom.gw.owner.claude"
		vault.addRequest(team, typedRequest("r1", 600_000L), now = 1_000L)
		assertEquals(1, vault.request("r1")!!.attempt)
		vault.recordAnswer(vault.request("r1")!!, now = 2_000L)
		vault.settleRequest("r1")

		vault.addRequest(team, typedRequest("r2", 600_000L), now = 5_000L)
		val second = vault.request("r2")!!
		assertEquals(2, second.attempt)
		assertEquals(3_000L, second.sinceAnswerMs)
		vault.recordAnswer(second, now = 6_000L)
		vault.settleRequest("r2")

		// The count chains through the latest answer even once the first has left the window.
		vault.addRequest(team, typedRequest("r3", 600_000L), now = 6_000L + REPEAT_WINDOW_MS)
		assertEquals(3, vault.request("r3")!!.attempt)

		// Another command, another team, or a stale answer starts over.
		vault.addRequest(team, entryRequest("other", 600_000L), now = 7_000L)
		assertEquals(1, vault.request("other")!!.attempt)
		vault.addRequest("dom.gw.host.alice", typedRequest("r4", 600_000L), now = 7_000L)
		assertEquals(1, vault.request("r4")!!.attempt)
		vault.addRequest(team, typedRequest("r5", 600_000L), now = 7_000L + REPEAT_WINDOW_MS)
		assertEquals(1, vault.request("r5")!!.attempt)
		assertNull(vault.request("r5")!!.sinceAnswerMs)
	}

	@Test
	fun aReopenKeepsEntriesAndLiveRequestsOnly() {
		val store = FakeStore()
		val first = VaultManager(store)
		val now = System.currentTimeMillis()
		first.applyList(list(2L, 0L, entry("a")))
		first.addRequest("dom.gw.host.alice", entryRequest("r1", now + 60_000L), now = now)
		first.addRequest("dom.gw.host.alice", entryRequest("stale", now + 1L), now = now)

		val reopened = VaultManager(store)
		assertEquals(2L, reopened.routerRevision)
		assertEquals(listOf("a"), reopened.live().map { it.clear.id })
		assertEquals(listOf("r1"), reopened.pending.value.map { it.requestId })
		reopened.wipe()
		assertTrue(reopened.live().isEmpty())
	}
}
