package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.board.BoardStore
import org.junit.Assert.assertEquals
import org.junit.Test

/** Clear and re-provision may hand the device to a different owner, and the process is not
 * restarted: Repo.get memoizes ChatRepository, so every delegate survives the wipe still holding
 * the previous owner's data. */
class ClearsOnReprovisionTest {
	/** [wipe] is what clearProvisioning does to the board, leaving only the in-memory copy. */
	private class FakeStore : BoardStore {
		var blob: String? = null

		fun wipe() {
			blob = null
		}

		override fun loadTaskBoard(): String? = blob

		override fun saveTaskBoard(json: String) {
			blob = json
		}

		override fun loadGatewayId(): String = "gw-route"
	}

	/** The roster is instance-side, so pin the field set it has to name. A delegate that states its
	 * own wipe and is then left out of it fails here. */
	@Test
	fun everyRepositoryFieldDeclaringAWipeIsInTheRoster() {
		val declared = ChatRepository::class.java.declaredFields
			.filter { ClearsOnReprovision::class.java.isAssignableFrom(it.type) }
			.map { it.name }
			.toSet()
		// playback: the run names the previous owner's messages and every transport surface draws it.
		assertEquals(setOf("board", "vault", "presence", "trust", "drain", "playback"), declared)
	}
}
