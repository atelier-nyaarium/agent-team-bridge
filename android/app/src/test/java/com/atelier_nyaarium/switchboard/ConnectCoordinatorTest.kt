package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The connect sequence over a fake Router preflight and a real identity door, so what a connect
 * learns and what it publishes are asserted together rather than through the repository.
 */
class ConnectCoordinatorTest {
	private class FakeReach(private val answer: () -> RouterReach?) : ConsoleReach {
		var calls = 0
		override suspend fun apiReachable(): RouterReach? {
			calls++
			return answer()
		}
	}

	private class FakeHost : ConnectHost {
		override var homeGatewayId = ""
		override var firstRooted = false
		override var consoleAdmitted = false
		var gateways = listOf("gw")
		var rootPending = true
		var admissionError: Throwable? = null
		var gatewayError: Throwable? = null
		val ops = mutableListOf<String>()
		var savedGatewayId: String? = null

		override fun saveGatewayId(id: String) {
			savedGatewayId = id
			ops += "saveGateway:$id"
		}
		override fun keyringGateways(): List<String> {
			gatewayError?.let { throw it }
			return gateways
		}
		override fun withoutTombstoned(teams: List<Team>) = teams

		override suspend fun firstRootIfPending(): Boolean {
			ops += "firstRoot"
			return rootPending
		}
		override suspend fun submitConsoleAdmission() {
			ops += "admission"
			admissionError?.let { throw it }
		}
		override fun reportCapabilities() { ops += "capabilities" }
		override fun refreshDisplayName() { ops += "displayName" }
		override fun attachIngest() { ops += "attachIngest" }
		override fun flushIngest() { ops += "flushIngest" }
	}

	private fun blob(appToken: String = "token"): String = wireJson.encodeToString(
		com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(),
		com.atelier_nyaarium.switchboard.proto.Provisioning(appToken = appToken, device = "device"),
	)

	private fun coordinator(
		identity: PhoneIdentity,
		host: ConnectHost,
		state: MutableStateFlow<ChatState>,
		reach: ConsoleReach,
	) = ConnectCoordinator(identity, { reach }, state, host)

	@Test
	fun aReachedRouterNamesTheDomainAndPublishesTheConnectedRoster() = runBlocking {
		val store = testStore()
		val identity = PhoneIdentity(store, FederationManager(store))
		identity.provision(blob())
		assertEquals(BootState.Missing(setOf(Need.DOMAIN_ID)), identity.bootState.value)

		val state = MutableStateFlow(ChatState())
		val host = FakeHost()
		coordinator(identity, host, state, FakeReach { RouterReach(domainId = "learned") }).connect()

		assertEquals("learned", identity.readyOrNull()?.domainId)
		assertEquals("connected", state.value.status)
		assertTrue(state.value.connected)
		assertNull(state.value.error)
		assertEquals("gw", state.value.homeGatewayId)
		assertEquals("gw", host.savedGatewayId)
		assertEquals(listOf("gw"), state.value.admittedGateways)
		assertEquals(
			listOf("attachIngest", "firstRoot", "admission", "saveGateway:gw", "capabilities", "displayName", "flushIngest"),
			host.ops,
		)
	}

	@Test
	fun anUnreachableRouterStopsBeforeAdmissionAndLearnsNothing() = runBlocking {
		val store = testStore()
		val identity = PhoneIdentity(store, FederationManager(store))
		identity.provision(blob())

		val state = MutableStateFlow(ChatState())
		val host = FakeHost()
		coordinator(identity, host, state, FakeReach { error("Connection refused") }).connect()

		assertEquals("connecting", state.value.status)
		assertFalse(state.value.connected)
		assertNull(identity.readyOrNull())
		assertEquals(listOf("attachIngest", "flushIngest"), host.ops)
	}

	@Test
	fun aPendingFirstRootStopsBeforeAdmission() = runBlocking {
		val store = testStore()
		val identity = PhoneIdentity(store, FederationManager(store))
		identity.provision(blob())

		val state = MutableStateFlow(ChatState())
		val host = FakeHost().also { it.rootPending = false }
		coordinator(identity, host, state, FakeReach { RouterReach(domainId = "learned") }).connect()

		assertEquals("learned", identity.readyOrNull()?.domainId)
		assertFalse(state.value.connected)
		assertEquals(listOf("attachIngest", "firstRoot", "flushIngest"), host.ops)
	}

	@Test
	fun aRejectedAdmissionStopsWithTheLatchLeftAsItWas() = runBlocking {
		val store = testStore()
		val identity = PhoneIdentity(store, FederationManager(store))
		identity.provision(blob())
		identity.setConsoleAdmitted(true, identity.blob()!!)

		val state = MutableStateFlow(ChatState())
		val host = FakeHost().also { it.admissionError = IllegalStateException("Console admission rejected") }
		coordinator(identity, host, state, FakeReach { RouterReach(domainId = "learned") }).connect()

		assertFalse(state.value.connected)
		assertTrue(store.consoleAdmitted)
		assertEquals(listOf("attachIngest", "firstRoot", "admission", "flushIngest"), host.ops)
	}

	@Test
	fun aSyncLaggingGatewayDropsTheAdmittedLatchSoTheNextConnectResubmits() = runBlocking {
		val store = testStore()
		val identity = PhoneIdentity(store, FederationManager(store))
		identity.provision(blob())
		identity.setConsoleAdmitted(true, identity.blob()!!)
		assertTrue(store.consoleAdmitted)

		val state = MutableStateFlow(ChatState())
		val host = FakeHost().also { it.gatewayError = IllegalStateException("console is not admitted to the Domain") }
		coordinator(identity, host, state, FakeReach { RouterReach(domainId = "learned") }).connect()

		assertEquals("connecting", state.value.status)
		assertFalse(state.value.connected)
		assertFalse(store.consoleAdmitted)
	}

	@Test
	fun anUnprovisionedDeviceNeverReachesTheRouter() = runBlocking {
		val store = testStore()
		val identity = PhoneIdentity(store, FederationManager(store))

		val state = MutableStateFlow(ChatState())
		val host = FakeHost()
		val reach = FakeReach { RouterReach() }
		coordinator(identity, host, state, reach).connect()

		assertEquals(0, reach.calls)
		assertEquals(listOf("attachIngest"), host.ops)
	}
}
