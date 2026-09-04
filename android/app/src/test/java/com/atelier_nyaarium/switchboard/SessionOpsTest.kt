package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleCreateSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleListDirsResult
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.parseTarget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class SessionOpsTest {
	private class FakeHost : SessionHost {
		override val state = MutableStateFlow(ChatState())
		override val homeGatewayId = "gw"
		override val localDomain = "dom"
		override val forgottenUntil = mutableMapOf<String, Long>()
		override val sandboxDirs: Map<String, List<String>>? = null
		override var terminalRefreshMs = 1_000L
		override val spawnRetryWindowMs = 40_000L
		override val forgetTombstoneMs = 50_000L
		val created = mutableListOf<String>()
		val remembered = mutableListOf<String>()
		val wakes = mutableListOf<String>()
		val forgotten = mutableListOf<Pair<String, String?>>()
		var scheduled = 0
		var goals = 0
		var playback = 0
		var persisted = 0

		override fun canonicalTarget(team: String) = parseTarget(team, localDomain, homeGatewayId).canonical
		override fun forgetReadAnchor(team: String) = Unit
		override fun rememberProject(target: String) { remembered += target }
		override fun keyringGateways() = listOf(homeGatewayId)
		override fun launchInBackground(block: suspend () -> Unit) { CoroutineScope(Dispatchers.Unconfined).launch { block() } }
		override suspend fun peekTerminal(team: String, sinceHash: String?) = ConsolePeekResult(hash = "hash")
		override suspend fun createSession(
			target: String,
			sessionName: String?,
			displayLabel: String?,
			workdir: String?,
			opId: String,
		) = ConsoleCreateSessionResult(created = true).also { created += target }
		override suspend fun tmuxSend(team: String, text: String?, key: String?, submit: Boolean) = Unit
		override suspend fun listDirs(path: String, hostTarget: String, spawn: String) = ConsoleListDirsResult(emptyList())
		override suspend fun wake(target: String, opId: String) { wakes += target }
		override suspend fun closeSession(team: String) = Unit
		override suspend fun forget(team: String, boardDisposition: String?) = boardDisposition.also { forgotten += team to it }
		override fun persistThreads(threads: Map<String, List<Message>>, anchors: Map<String, ReadAnchor>) { persisted++ }
		override fun persistLabels(labels: Map<String, String>) { persisted++ }
		override fun persistDrafts(drafts: Map<String, Draft>) { persisted++ }
		override fun cancelScheduled(team: String) { scheduled++ }
		override fun cancelGoal(team: String) { goals++ }
		override fun dropPlayback(team: String) { playback++ }
		override fun scheduleAttachmentDelete(srcs: List<String>) = Unit
		override fun refreshAfterAction() = Unit
		override suspend fun reapplyCachedTeams() = Unit
	}

	@Test
	fun wakeTargetIsTheQualifiedSessionAddress() {
		assertEquals("dom.gw.host.82d560", wakeTargetOf("dom.gw.host.82d560", "dom", "gw"))
		assertEquals("dom.gw.host.82d560", wakeTargetOf("host.82d560", "dom", "gw"))
	}

	@Test
	fun wakeTargetRefusesASpawnPointOrGarbage() {
		assertNull(wakeTargetOf("dom.gw.host", "dom", "gw"))
		assertNull(wakeTargetOf("host", "dom", "gw"))
		assertNull(wakeTargetOf("a.b.c.d.e", "dom", "gw"))
	}

	@Test
	fun spawnRecordsProjectAndSettlesPendingState() = runBlocking {
		val host = FakeHost()
		SessionOps(host).spawnSession("dom.gw.project", "label", "/work")

		assertEquals(listOf("dom.gw.project"), host.remembered)
		assertEquals(listOf("dom.gw.project"), host.created)
		assertEquals(emptySet<Pair<String, String>>(), host.state.value.pendingSpawns)
	}

	@Test
	fun wakePublishesReceiptAndClearRemovesIt() {
		val host = FakeHost()
		val ops = SessionOps(host)
		ops.wakeSession("dom.gw.host.session")

		assertEquals(listOf("dom.gw.host.session"), host.wakes)
		val now = System.currentTimeMillis()
		assertEquals(ActionReceipt.Outcome.ACCEPTED, ops.receiptFor("dom.gw.host.session", now)?.outcome)
		ops.clearReceipt("dom.gw.host.session")
		assertNull(ops.receiptFor("dom.gw.host.session", now))
	}

	@Test
	fun forgetCascadesStateCleanupAndGatewayDisposition() {
		val host = FakeHost()
		val team = "dom.gw.host.session"
		host.state.value = ChatState(
			teams = listOf(Team(name = team, presence = Presence.reported(Presence.ONLINE, Authority.LIVE))),
			threads = mapOf(team to listOf(Message(false, "hello", 1L))),
			labels = mapOf(team to "label"),
			drafts = mapOf(team to Draft(text = "draft")),
		)
		SessionOps(host).forget(team, "cancel")

		assertNull(host.state.value.teams.firstOrNull { it.name == team })
		assertNull(host.state.value.threads[team])
		assertNull(host.state.value.labels[team])
		assertNull(host.state.value.drafts[team])
		assertNotNull(host.forgottenUntil[team])
		assertEquals(listOf(team to "cancel"), host.forgotten)
		assertEquals(1, host.scheduled)
		assertEquals(1, host.goals)
		assertEquals(1, host.playback)
		assertEquals(3, host.persisted)
	}
}
