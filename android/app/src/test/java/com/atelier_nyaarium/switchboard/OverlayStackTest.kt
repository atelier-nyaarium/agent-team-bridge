package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/** Opening keeps the way back; leaving returns to what opened it. */
class OverlayStackTest {
	@Test
	fun openingFromAScreenKeepsTheWayBackToIt() {
		// Add gateway hangs off Users; the return path must survive the second open.
		val opened = emptyList<Overlay>().pushOverlay(Overlay.Users).pushOverlay(Overlay.AddGateway)

		assertEquals(Overlay.AddGateway, opened.last())
		assertEquals(listOf<Overlay>(Overlay.Users), opened.popOverlay())
		assertEquals(emptyList<Overlay>(), opened.popOverlay().popOverlay())
	}

	@Test
	fun aDoubleTapCostsOneBackPress() {
		val opened = emptyList<Overlay>().pushOverlay(Overlay.Manage).pushOverlay(Overlay.Manage)

		assertEquals(1, opened.size)
	}

	@Test
	fun theSameScreenReachedFromTwoPlacesKeepsBothReturnPaths() {
		// Add gateway hangs off Gateways and off Users; each has to return to its own opener.
		val fromGateways = emptyList<Overlay>().pushOverlay(Overlay.Manage).pushOverlay(Overlay.AddGateway)
		val fromUsers = emptyList<Overlay>().pushOverlay(Overlay.Users).pushOverlay(Overlay.AddGateway)

		assertEquals(Overlay.Manage, fromGateways.popOverlay().last())
		assertEquals(Overlay.Users, fromUsers.popOverlay().last())
	}

	@Test
	fun theDeepestChainUnwindsOneScreenAtATime() {
		// The hosting chain: Users, the networks list, one tenant, then the in-person compare.
		val ctx = EnrollCeremonyContext(
			role = EnrollCeremony.ADMIN,
			handshakeId = "hs",
			pin = "pin",
			myParty = com.atelier_nyaarium.switchboard.proto.EnrollParty("s", "b", "d"),
		)
		var stack = emptyList<Overlay>()
			.pushOverlay(Overlay.Users)
			.pushOverlay(Overlay.HostNetworks)
			.pushOverlay(Overlay.HostTenant("guest42"))
			.pushOverlay(Overlay.AdminCeremony(ctx, "blob", "Ada"))

		val seen = mutableListOf<Overlay>()
		while (stack.isNotEmpty()) {
			seen += stack.last()
			stack = stack.popOverlay()
		}
		assertEquals(
			listOf(
				Overlay.AdminCeremony(ctx, "blob", "Ada"),
				Overlay.HostTenant("guest42"),
				Overlay.HostNetworks,
				Overlay.Users,
			),
			seen,
		)
	}

	@Test
	fun twoTenantsAreDistinctScreens() {
		// Carried params are part of identity, so opening a sibling detail does not dedupe onto it.
		val stack = emptyList<Overlay>()
			.pushOverlay(Overlay.HostTenant("guest42"))
			.pushOverlay(Overlay.HostTenant("guest43"))

		assertEquals(2, stack.size)
	}

	@Test
	fun popOnAnEmptyStackIsHarmless() {
		assertEquals(emptyList<Overlay>(), emptyList<Overlay>().popOverlay())
	}
}
