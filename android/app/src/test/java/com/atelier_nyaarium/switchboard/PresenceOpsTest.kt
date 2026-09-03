package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import com.atelier_nyaarium.switchboard.proto.PresencePlane
import com.atelier_nyaarium.switchboard.proto.RosterEntry
import com.atelier_nyaarium.switchboard.proto.TeamInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PresenceOpsTest {
	private class FakeHost : PresenceHost {
		override val state = MutableStateFlow(ChatState())
		override val localGatewayId = "local"
		override var storedDisplayName = ""
		override val forgottenUntil = mutableMapOf<String, Long>()
		var slot: RouterStateSlot? = null
		var failSlotWrite = false
		var savedLabels: Map<String, String>? = null
		var savedAbsence: Map<String, Int>? = null

		override suspend fun <T> withDrainMutex(block: suspend () -> T): T = block()
		override suspend fun resetPlaneCursors() = Unit
		override fun interruptDrain() = Unit
		override suspend fun pruneCrossDomainVersions(ownedDomainIds: Set<String>) = Unit
		override suspend fun upsertCrossDomainVersions(entries: List<CrossDomainPresenceEntry>) = Unit
		override suspend fun reportRead(team: String, epoch: Long, seq: Long) = Unit
		override suspend fun fetchTeams() = TeamsAnswer(emptyList())
		override fun fetchConnectedGateways(): List<String>? = null
		override fun loadRouterState(kind: String) = slot
		override fun saveRouterState(kind: String, slot: RouterStateSlot) {
			if (failSlotWrite) error("storage fault")
			this.slot = slot
		}
		override fun persistLabels(labels: Map<String, String>) { savedLabels = labels }
		override fun persistAbsenceStreaks(streaks: Map<String, Int>) { savedAbsence = streaks }
		override fun persistReadAnchors(anchors: Map<String, ReadAnchor>) = Unit
		override fun receiptFor(team: String, now: Long): ActionReceipt? = null
		override fun clearReceipt(team: String) = Unit
	}

	private fun info(name: String, status: String = Presence.ONLINE) = TeamInfo(
		team = name,
		gatewayId = "local",
		status = status,
		kind = "loose",
		queue_depth = 0,
	)

	private fun projection(version: Long, name: String = "host.session") = OwnerPresenceProjection(
		plane = PresencePlane(epoch = 1, version = version),
		rows = listOf(info(name)),
		linked = emptyList(),
		roster = listOf(RosterEntry("local", true, 1, 1)),
		coverage = DiscoverCoverage(rosterKnown = true, asked = 1, answered = 1),
		spawnPoints = emptyList(),
	)

	private fun answer(name: String) = TeamsAnswer(listOf(testTeam(name)))

	@Test
	fun restoreLastProjectionAppliesStoredSlotWithoutSelfBlocking() = runBlocking {
		val host = FakeHost()
		val stored = projection(1)
		host.slot = RouterStateSlot(1, 1, wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), stored))
		PresenceOps(host).restoreLastProjection()
		assertEquals(1, host.state.value.teams.size)
	}

	@Test
	fun newerOwnerProjectionAppliesAndPersistsTheSlot() = runBlocking {
		val host = FakeHost()
		PresenceOps(host).applyOwnerProjection(projection(2))
		assertEquals(2L, host.slot?.version)
		assertEquals(1, host.state.value.teams.size)
	}

	@Test
	fun olderOwnerProjectionAfterNewerChangesNeitherMemoryNorSlot() = runBlocking {
		val host = FakeHost()
		val ops = PresenceOps(host)
		ops.applyOwnerProjection(projection(2, "host.new"))
		ops.applyOwnerProjection(projection(1, "host.old"))
		assertEquals("local.local.host.new", host.state.value.teams.single().name)
		assertEquals(2L, host.slot?.version)
	}

	@Test
	fun slotWriteFaultStillAppliesProjectionInMemory() = runBlocking {
		val host = FakeHost().also { it.failSlotWrite = true }
		PresenceOps(host).applyOwnerProjection(projection(1))
		assertEquals(1, host.state.value.teams.size)
		assertNull(host.slot)
	}

	@Test
	fun domainLinkPresenceCallCannotLetAnOlderPullOverwriteLastRawTeams() = runBlocking {
		val host = FakeHost()
		val ops = PresenceOps(host)
		ops.applyOwnerProjection(projection(2, "host.new"))
		ops.applyDiscovery(answer("domain.local.host.old"), issuedAt = 0)
		assertEquals("local.local.host.new", ops.lastRawTeams?.single()?.name)
	}

	@Test
	fun staleDiscoveryAndPlanePresenceDoNothingButFreshOnesApply() = runBlocking {
		val host = FakeHost()
		val ops = PresenceOps(host)
		ops.applyOwnerProjection(projection(2, "host.new"))
		ops.applyDiscovery(answer("domain.local.host.stale"), issuedAt = 0)
		ops.applyPlanePresence(listOf(testTeam("domain.local.host.stale")), issuedAt = 0)
		assertEquals("local.local.host.new", ops.lastRawTeams?.single()?.name)
		ops.applyDiscovery(answer("domain.local.host.fresh"), issuedAt = Long.MAX_VALUE)
		assertEquals("domain.local.host.fresh", ops.lastRawTeams?.single()?.name)
		ops.applyPlanePresence(listOf(testTeam("domain.local.host.latest")), issuedAt = Long.MAX_VALUE)
		assertEquals("domain.local.host.latest", ops.lastRawTeams?.single()?.name)
	}
}
