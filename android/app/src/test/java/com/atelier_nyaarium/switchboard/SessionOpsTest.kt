package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionOpsTest {
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
}
