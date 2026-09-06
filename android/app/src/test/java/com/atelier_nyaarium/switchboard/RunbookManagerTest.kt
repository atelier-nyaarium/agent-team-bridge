package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookParameter
import com.atelier_nyaarium.switchboard.runbooks.RunbookManager
import com.atelier_nyaarium.switchboard.runbooks.RunbookStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class RunbookManagerTest {
	private class MemoryStore : RunbookStore {
		var blob: String? = null
		var refusing = false
		override fun loadRunbooks() = blob
		override fun saveRunbooks(json: String) {
			if (refusing) throw java.io.IOException("no room")
			blob = json
		}
	}

	private fun book(id: String, revision: Long = 1L) = Runbook(
		id = id,
		name = id,
		body = "release {{level}}",
		parameters = listOf(RunbookParameter(name = "level", label = "Level", kind = "text")),
		revision = revision,
	)

	@Test
	fun theLibrarySurvivesTheAppBeingRestarted() {
		val store = MemoryStore()
		RunbookManager(store).merge(listOf(book("deploy"), book("release")))

		val reopened = RunbookManager(store)
		assertEquals(listOf("deploy", "release"), reopened.all().map { it.id })
		assertEquals("release {{level}}", reopened.find("deploy")?.body)

		reopened.remove("deploy")
		assertEquals(listOf("release"), RunbookManager(store).all().map { it.id })
	}

	@Test
	fun aCopyArrivingFromAGatewayOnlyWinsWhenItIsNewer() {
		val manager = RunbookManager(MemoryStore())
		manager.merge(listOf(book("deploy", revision = 4L)))

		manager.merge(listOf(book("deploy", revision = 2L)))
		assertEquals(4L, manager.find("deploy")?.revision)

		manager.merge(listOf(book("deploy", revision = 9L)))
		assertEquals(9L, manager.find("deploy")?.revision)
	}

	@Test
	fun aLibraryOnDiskThatNoLongerDecodesStartsEmptyRatherThanCrashing() {
		val store = MemoryStore().also { it.blob = "{not json" }
		assertEquals(emptyList<Runbook>(), RunbookManager(store).all())
	}

	@Test
	fun aLibraryThatCouldNotBeWrittenIsNotShownAsIfItHad() {
		val store = MemoryStore()
		val manager = RunbookManager(store)
		manager.merge(listOf(book("deploy")))

		store.refusing = true
		assertEquals(listOf("deploy"), manager.merge(listOf(book("release"))).map { it.id })
		// What a restart would find, which is what the owner has.
		assertEquals(listOf("deploy"), RunbookManager(store).all().map { it.id })
	}

	@Test
	fun reprovisioningLeavesThePreviousOwnerNothing() {
		val store = MemoryStore()
		val manager = RunbookManager(store)
		manager.merge(listOf(book("deploy")))

		runBlocking { manager.clearInMemory() }
		assertEquals(emptyList<Runbook>(), manager.all())
		assertEquals(emptyList<Runbook>(), RunbookManager(store).all())
	}

	@Test
	fun aClearTheDiskRefusesStillTakesTheLibraryOutOfMemory() {
		val store = MemoryStore()
		val manager = RunbookManager(store)
		manager.merge(listOf(book("deploy")))

		store.refusing = true
		runBlocking { manager.clearInMemory() }
		assertEquals(emptyList<Runbook>(), manager.all())
	}
}
