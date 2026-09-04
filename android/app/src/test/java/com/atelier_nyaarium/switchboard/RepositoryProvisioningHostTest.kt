package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

class RepositoryProvisioningHostTest {
	@Test
	fun aNewDomainClearsTheOldHomeGateway() {
		assertEquals("new-home", selectHomeGateway("old-home", listOf("new-home")))
		assertEquals("", selectHomeGateway("old-home", emptyList()))
	}
}
