package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

class SandboxSeederTest {
	@Test
	fun sandboxSeedCarriesTheHomeGatewayFromTheTeamIntoStateInput() {
		assertEquals("home", sandboxHomeGateway("domain.home.session", "old"))
	}
}
