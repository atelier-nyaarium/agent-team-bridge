package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.runbooks.ParameterDraft
import com.atelier_nyaarium.switchboard.runbooks.RunbookDraft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class RunbookDraftTest {
	private fun draft(body: String, settings: Map<String, ParameterDraft> = emptyMap()) =
		RunbookDraft(id = "r1", name = "Release", body = body, settings = settings)

	@Test
	fun theParameterListFollowsTheBodyRatherThanBeingKeptBesideIt() {
		val one = draft("cut a {{level}} release")
		assertEquals(listOf("level"), one.declared)

		val two = one.copy(body = "cut a {{level}} release of {{repo}}")
		assertEquals(listOf("level", "repo"), two.declared)

		// A body that does not parse declares nothing rather than half a list.
		assertNull(one.copy(body = "cut a {{level").declared)
	}

	@Test
	fun deletingAPlaceholderOnlyHidesItsSettingsAndPastingItBackRestoresThem() {
		val settled = ParameterDraft(
			label = "Environment",
			kind = "choice",
			options = listOf("staging", "prod"),
			default = "prod",
		)
		val withSettings = draft("go {{env}}", mapOf("env" to settled))

		val removed = withSettings.copy(body = "go")
		assertEquals(emptyList<String>(), removed.declared)
		// Every setting comes back, not just the label, which is the whole point of keying by name.
		assertEquals(settled, removed.copy(body = "go {{env}}").settingsFor("env"))
	}

	@Test
	fun savingDropsSettingsNothingNames() {
		val orphaned = draft("go {{env}}")
			.withSettings("env") { it.copy(label = "Environment") }
			.withSettings("gone") { it.copy(label = "Gone") }
		val saved = orphaned.toRunbook()
		assertNotNull(saved)
		assertEquals(listOf("env"), saved?.parameters?.map { it.name })
	}

	@Test
	fun aSaveBumpsTheRevisionSoAGatewayTakesIt() {
		val saved = draft("go {{env}}").copy(revision = 4L)
			.withSettings("env") { it.copy(label = "Environment") }
			.toRunbook()
		assertEquals(5L, saved?.revision)
	}

	@Test
	fun aChoiceMustOfferSomethingToChooseBeforeItCanBeSaved() {
		val choice = { setting: ParameterDraft ->
			draft("go {{env}}", mapOf("env" to setting)).refusal()
		}
		assertNull(choice(ParameterDraft(label = "Environment", kind = "choice", options = listOf("prod"))))
		assertNotNull(choice(ParameterDraft(label = "Environment", kind = "choice")))
		assertNotNull(choice(ParameterDraft(label = "Environment", kind = "choice", options = listOf("a", "a"))))
		assertNotNull(
			choice(ParameterDraft(label = "Environment", kind = "choice", options = listOf("prod"), default = "dev")),
		)
	}

	@Test
	fun everyRuleTheGatewayWouldRefuseOnIsCheckedBeforeSaveIsOffered() {
		val fill = { setting: ParameterDraft -> draft("go {{env}}", mapOf("env" to setting)).refusal() }
		// A filled value is text, never another template.
		assertNotNull(fill(ParameterDraft(label = "Environment", default = "{{other}}")))
		assertNotNull(
			fill(ParameterDraft(label = "Environment", kind = "choice", options = listOf("prod", "{{other}}"))),
		)
		// An empty option is a choice the owner cannot pick.
		assertNotNull(fill(ParameterDraft(label = "Environment", kind = "choice", options = listOf("prod", " "))))
	}

	@Test
	fun aDraftMissingItsOwnPartsRefusesRatherThanSaving() {
		assertNotNull(draft("").refusal())
		assertNotNull(draft("go {{env}}").copy(name = "").refusal())
		// A blank label would reach the owner as an unlabelled box.
		assertNotNull(draft("go {{env}}", mapOf("env" to ParameterDraft(label = " "))).refusal())
		assertNull(draft("go {{env}}", mapOf("env" to ParameterDraft(label = "Environment"))).refusal())
	}

	@Test
	fun anExistingRunbookRoundTripsThroughTheEditor() {
		val original = draft("go {{env}}", mapOf("env" to ParameterDraft(label = "Environment", default = "prod")))
			.toRunbook()
		assertNotNull(original)
		val reopened = RunbookDraft.of(original as com.atelier_nyaarium.switchboard.proto.Runbook)
		assertEquals(original.body, reopened.body)
		assertEquals("Environment", reopened.settingsFor("env").label)
		assertEquals("prod", reopened.settingsFor("env").default)
	}
}
