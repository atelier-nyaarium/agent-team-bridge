package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SttsProvider
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackOpsTest {
	private class FakePlayback : PlaybackPort {
		override val stts = SttsPlayer(File("/tmp/switchboard-playback"))
		override fun sttsClient(): SttsClient? = null
		override fun currentProvider(): SttsProvider? = null
		override fun sttsVoiceFor(providerId: String) = ""
		override val sttsVolume = 100
		override val sttsChimeVolume = 100
		override val sttsAutoPlay = "off"
		override fun sttsReady() = false
	}

	@Test
	fun enqueueOrderSurvivesPause() = runBlocking {
		val team = "local.gw.host.session"
		val state = MutableStateFlow(ChatState(openTabs = listOf(team), threads = mapOf(team to listOf(Message(false, "one", 1L), Message(false, "two", 2L)))))
		val ops = PlaybackOps(state, CoroutineScope(Dispatchers.Unconfined), FakePlayback(), object : PlaybackOpsCollaborators {
			override fun openThread(team: String) = team
		})

		ops.enqueueForPlay(team, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = true)
		ops.enqueueForPlay(team, 2L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = true)
		val before = ops.queueRows().map { it.entry.at }
		ops.pausePlayback()

		assertEquals(listOf(1L, 2L), before)
		// The head may already be speaking; the rest waits.
		assertEquals(2L, ops.queueRows().map { it.entry.at }.last())
		assertEquals(true, ops.transportState().second)
	}
}
