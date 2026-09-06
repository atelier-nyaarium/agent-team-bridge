package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VaultRequestTextTest {
	private fun typed(
		operation: String,
		team: String = "dom.sakura.owner.claude",
		attempt: Int = 1,
		since: Long? = null,
		asker: String? = null,
	) = VaultPendingRequest(
		team,
		VaultRequest.Typed(
			v = 1L,
			requestId = "r",
			operation = operation,
			shape = "sudo apt",
			sessionTarget = "helper.abc",
			deadlineAt = 10L,
			asker = asker,
		),
		0L,
		attempt,
		since,
	)

	private fun entry(team: String = "dom.hoshi.evie-bot.0713b7") =
		VaultPendingRequest(
			team,
			VaultRequest.Entry(
				entryId = "e1",
				v = 1L,
				requestId = "r",
				operation = "gh auth login",
				shape = "gh auth",
				sessionTarget = "evie-bot.0713b7",
				deadlineAt = 10L,
			),
			0L,
		)

	@Test
	fun aRowFromAnOlderGatewayReadsItsOnlyShapeAndCoversNothing() {
		val old = entry()
		assertEquals("gh auth", old.displayShape)
		assertEquals(emptyList<String>(), old.coveredShapes)
	}

	@Test
	fun theNewNameWinsWhenARowCarriesBoth() {
		val current = VaultPendingRequest(
			"dom.sakura.owner.claude",
			VaultRequest.Entry(
				entryId = "e1",
				v = 1L,
				requestId = "r",
				operation = "printf %s | sha256sum",
				shape = "stale",
				displayShape = "printf %s",
				coveredShapes = listOf("printf %s", "sha256sum"),
				sessionTarget = "host.alice",
				deadlineAt = 10L,
			),
			0L,
		)
		assertEquals("printf %s", current.displayShape)
		assertEquals(listOf("printf %s", "sha256sum"), current.coveredShapes)
	}

	@Test
	fun theRequesterIsTheMachineThenTheBoardName() {
		val state = ChatState(labels = mapOf("dom.hoshi.evie-bot.0713b7" to "Evie Auto Shutdown"))
		assertEquals("hoshi · Evie Auto Shutdown", requester(state, entry()))
		assertEquals("hoshi · 0713b7", requester(ChatState(), entry()))
		assertEquals("sakura", requester(ChatState(), typed("sudo apt upgrade")))
	}

	@Test
	fun theTitleNamesTheEntryOrTheProgramAskingForAPassword() {
		assertEquals("GitHub token", requestTitle(entry(), "GitHub token"))
		assertEquals("e1", requestTitle(entry(), null))
		assertEquals("Sudo request", requestTitle(typed("sudo apt upgrade"), null))
		assertEquals("Sudo request", requestTitle(typed("/usr/bin/sudo -k apt upgrade"), null))
		assertEquals("Password request", requestTitle(typed("ssh deploy@prod"), null))
	}

	@Test
	fun theCountdownStepsIntoSecondsUnderTwoMinutesAndReadsUrgent() {
		assertEquals(Expiry("Expires in 8 min", false), expiresIn(8 * 60_000L + 30_000L, now = 0L))
		assertEquals(Expiry("Expires in 2 min", false), expiresIn(EXPIRY_SECONDS_BELOW_MS, now = 0L))
		assertEquals(Expiry("Expires in 120 s", true), expiresIn(EXPIRY_SECONDS_BELOW_MS - 1, now = 0L))
		assertEquals(Expiry("Expires in 1 s", true), expiresIn(1L, now = 0L))
		assertEquals(Expiry("Expired", true), expiresIn(0L, now = 0L))
	}

	@Test
	fun theRepeatNoticeCountsSudoTriesAndStaysQuietOnAFirstAsk() {
		assertNull(repeatNotice(typed("sudo apt upgrade")))
		assertNull(repeatNotice(typed("sudo apt upgrade", attempt = 2)))
		assertEquals(
			"Asked again 20 s after your answer. Likely wrong password. 2 of 3.",
			repeatNotice(typed("sudo apt upgrade", attempt = 2, since = 20_400L)),
		)
		assertEquals("Asked again 5 s after your answer.", repeatNotice(typed("ssh deploy@prod", attempt = 2, since = 5_000L)))
		assertTrue(repeatNotice(typed("sudo -k apt upgrade", attempt = 3, since = 1_000L))!!.endsWith("3 of 3."))
	}

	@Test
	fun anAskerMakesTheRepeatDefinitive() {
		assertNull(repeatNotice(typed("sudo apt upgrade", asker = "1:2")))
		assertEquals("Wrong password. 2 of 3.", repeatNotice(typed("sudo apt upgrade", attempt = 2, asker = "1:2")))
		assertEquals("Not accepted. Try 3.", repeatNotice(typed("ssh deploy@prod", attempt = 3, asker = "1:2")))
	}
}
