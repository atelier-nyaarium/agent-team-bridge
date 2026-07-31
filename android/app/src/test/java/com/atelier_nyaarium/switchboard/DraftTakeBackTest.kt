package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ChatRepository.takeBackIntoDraft's merge (mergeTakenBackDraft): files always union so no caller
 * can drop a pick, text lands only onto a blank draft so anything already typed wins. See
 * takeBackIntoDraft's own doc for the rationale - this pins the pure merge it delegates to, and
 * the Draft.isOccupied predicate every composer UI check reads.
 */
class DraftTakeBackTest {
	private fun file(name: String, src: String) = MessageFile(name, "image/jpeg", src)

	@Test
	fun textLandsOnABlankDraft() {
		val merged = mergeTakenBackDraft(Draft(), "hello", emptyList())
		assertEquals(Draft(text = "hello"), merged)
	}

	@Test
	fun textNeverOverwritesWhatIsAlreadyTyped() {
		val current = Draft(text = "still typing")
		val merged = mergeTakenBackDraft(current, "restored text", emptyList())
		assertEquals("still typing", merged.text)
	}

	@Test
	fun whitespaceOnlyTextStillCountsAsBlank() {
		// A composer full of spaces is not "something typed" worth protecting - same blank test
		// Draft.isOccupied itself uses, so the guard and the UI's enabled-state check never disagree.
		val current = Draft(text = "   ")
		val merged = mergeTakenBackDraft(current, "restored text", emptyList())
		assertEquals("restored text", merged.text)
	}

	@Test
	fun filesAlwaysUnionEvenWhileTextIsGuarded() {
		// Even while text is protected (something is being typed), a restored file must still land -
		// files have a meaningful merge, unlike text, so no caller can drop a pick.
		val current = Draft(text = "still typing", files = listOf(file("a.jpg", "src-a")))
		val merged = mergeTakenBackDraft(current, "restored text", listOf(file("b.jpg", "src-b")))
		assertEquals("still typing", merged.text)
		assertEquals(listOf(file("a.jpg", "src-a"), file("b.jpg", "src-b")), merged.files)
	}

	@Test
	fun aPicksOriginSurvivesTakingBackAFailedSend() {
		// Where a file came from is read from a content Uri at pick time and is unrecoverable after,
		// so a merge that dropped it would lose it permanently and persist the loss. Taking back an
		// unsendable message is exactly when the composer is most complicated to look at.
		val current = Draft(
			files = listOf(file("a.jpg", "src-a")),
			locations = mapOf("src-a" to "Download"),
		)

		val merged = mergeTakenBackDraft(current, "restored", listOf(file("b.jpg", "src-b")))

		assertEquals("Download", merged.locations["src-a"])
	}

	@Test
	fun takenBackFilesBringNoOriginOfTheirOwn() {
		// A sent file's origin was never known: it is read at pick time and the message has since
		// been through the wire, which carries no such field by construction.
		val merged = mergeTakenBackDraft(Draft(), "restored", listOf(file("b.jpg", "src-b")))

		assertEquals(emptyMap<String, String>(), merged.locations)
	}

	@Test
	fun unionDoesNotDuplicateAnIdenticalFile() {
		val shared = file("a.jpg", "src-a")
		val current = Draft(files = listOf(shared))
		val merged = mergeTakenBackDraft(current, "", listOf(shared))
		assertEquals(listOf(shared), merged.files)
	}

	@Test
	fun emptyDraftTakesBothTextAndFiles() {
		val merged = mergeTakenBackDraft(Draft(), "hello", listOf(file("a.jpg", "src-a")))
		assertEquals(Draft("hello", listOf(file("a.jpg", "src-a"))), merged)
	}

	@Test
	fun isOccupiedTracksTextOrFiles() {
		assertFalse(Draft().isOccupied)
		assertFalse(Draft(text = "   ").isOccupied)
		assertTrue(Draft(text = "x").isOccupied)
		assertTrue(Draft(files = listOf(file("a.jpg", "src-a"))).isOccupied)
	}
}
