package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProvisioningConversationIdTest {
	private val blob = "{\"appToken\":\"token\",\"device\":\"device\"}"

	@Test
	fun sameIdentityReusesStoredIdAndBlobIdOverridesIt() {
		val store = testStore()
		val first = Provisioning.parse(blob, store)
		store.save(blob)

		assertEquals(first.conversationId, Provisioning.parse(blob, store).conversationId)

		val named = Provisioning.parse(
			"{\"appToken\":\"token\",\"device\":\"device\",\"conversationId\":\"named\"}",
			store,
		)
		assertEquals("named", named.conversationId)
		assertEquals("named", store.loadConversationId())
	}

	@Test
	fun transportChangesReuseStoredId() {
		val store = testStore()
		val first = Provisioning.parse(
			"{\"routerUrl\":\"https://old\",\"routerCertFp\":\"old\",\"appToken\":\"token\"}",
			store,
		)
		store.save("{\"routerUrl\":\"https://old\",\"routerCertFp\":\"old\",\"appToken\":\"token\"}")

		val hostChanged = Provisioning.parse(
			"{\"routerUrl\":\"https://new\",\"routerCertFp\":\"old\",\"appToken\":\"token\"}",
			store,
		)
		assertEquals(first.conversationId, hostChanged.conversationId)
		store.save("{\"routerUrl\":\"https://new\",\"routerCertFp\":\"old\",\"appToken\":\"token\"}")

		val fingerprintChanged = Provisioning.parse(
			"{\"routerUrl\":\"https://new\",\"routerCertFp\":\"new\",\"appToken\":\"token\"}",
			store,
		)
		assertEquals(first.conversationId, fingerprintChanged.conversationId)
	}

	@Test
	fun differentBlobMintsFreshId() {
		val store = testStore()
		val first = Provisioning.parse(blob, store)
		store.save(blob)

		val second = Provisioning.parse("{\"appToken\":\"other\",\"device\":\"device\"}", store)

		assertNotEquals(first.conversationId, second.conversationId)
	}

	@Test
	fun clearProvisioningDropsConversationId() {
		val store = testStore()
		val previous = Provisioning.parse(blob, store).conversationId

		store.clearProvisioning()

		assertNull(store.loadConversationId())
		assertNotEquals(previous, Provisioning.parse(blob, store).conversationId)
	}

	@Test
	fun deviceNameNormalizesRouterDisallowedCharacters() {
		val provisioning = Provisioning.parse("{\"device\":\"pixel/pro\\r\\nmodel\"}", testStore())

		assertEquals("pixel-pro--model", provisioning.device)
	}

	@Test
	fun deviceNameIsLimitedTo64Characters() {
		val provisioning = Provisioning.parse("{\"device\":\"${"x".repeat(65)}\"}", testStore())

		assertEquals(64, provisioning.device.length)
	}

	@Test
	fun emptyDeviceNameFallsBackToAndroid() {
		val provisioning = Provisioning.parse("{\"device\":\"\"}", testStore())

		assertEquals("android", provisioning.device)
	}
}
