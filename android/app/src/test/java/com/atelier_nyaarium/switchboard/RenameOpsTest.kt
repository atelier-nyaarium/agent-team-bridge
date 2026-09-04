package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRenameSessionResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class RenameOpsTest {
	private val team = "domain.home.spawn.session"

	@Test
	fun renameEndsWithAPresenceRefreshAndKeepsTheAppliedLabel() = runBlocking {
		val host = FakeRenameHost()
		RenameOps(host).rename(team, "renamed")
		assertEquals(1, host.presenceRefreshes)
		assertEquals("renamed", host.state.value.labels[team])
	}

	@Test
	fun aRejectedRenameRevertsTheOptimisticLabelAndSaysSo() = runBlocking {
		val host = FakeRenameHost(renamed = false)
		host.setLabel(team, "before")
		RenameOps(host).rename(team, "renamed")
		assertEquals("before", host.state.value.labels[team])
		assertEquals(listOf("Could not rename to \"renamed\""), host.state.value.transientMessages)
		assertEquals(1, host.presenceRefreshes)
	}

	private class FakeRenameHost(private val renamed: Boolean = true) : RenameHost {
		override val state = MutableStateFlow(ChatState(homeGatewayId = "home"))
		var presenceRefreshes = 0

		override fun localDomain() = "domain"
		override fun setLabel(team: String, name: String) {
			state.value = state.value.copy(labels = if (name.isEmpty()) state.value.labels - team else state.value.labels + (team to name))
		}
		override fun persistLabels(labels: Map<String, String>) = Unit
		override suspend fun renameSession(team: String, name: String) = ConsoleRenameSessionResult(renamed, name)
		override suspend fun refreshPresence() {
			presenceRefreshes++
		}
	}
}
