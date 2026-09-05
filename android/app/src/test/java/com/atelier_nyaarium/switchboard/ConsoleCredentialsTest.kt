package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConsoleCredentialsTest {
	private val blob = "{\"appToken\":\"token\",\"device\":\"device\"}"

	private fun door(store: AppStateStore) = PhoneIdentity(store, FederationManager(store))

	@Test
	fun parsingWritesNothingAndTheDoorIsWhatRemembers() {
		val store = testStore()
		val parsed = ConsoleCredentials.parse(blob, store)

		assertNull(store.loadConversationId())
		assertNotEquals(parsed.conversationId, ConsoleCredentials.parse(blob, store).conversationId)

		door(store).saveBlob(blob)
		val remembered = store.loadConversationId()

		assertEquals(remembered, ConsoleCredentials.parse(blob, store).conversationId)
	}

	@Test
	fun aBlobNamingItsOwnIdOverridesWhatIsRemembered() {
		val store = testStore()
		door(store).saveBlob(blob)

		val named = "{\"appToken\":\"token\",\"device\":\"device\",\"conversationId\":\"named\"}"
		door(store).saveBlob(named)

		assertEquals("named", store.loadConversationId())
		assertEquals("named", ConsoleCredentials.parse(named, store).conversationId)
	}

	@Test
	fun transportChangesReuseTheRememberedId() {
		val store = testStore()
		val identity = door(store)
		identity.saveBlob("{\"routerUrl\":\"https://old\",\"routerCertFp\":\"old\",\"appToken\":\"token\"}")
		val first = store.loadConversationId()

		identity.saveBlob("{\"routerUrl\":\"https://new\",\"routerCertFp\":\"old\",\"appToken\":\"token\"}")
		assertEquals(first, store.loadConversationId())

		identity.saveBlob("{\"routerUrl\":\"https://new\",\"routerCertFp\":\"new\",\"appToken\":\"token\"}")
		assertEquals(first, store.loadConversationId())
	}

	@Test
	fun aDifferentCredentialMintsAFreshId() {
		val store = testStore()
		val identity = door(store)
		identity.saveBlob(blob)
		val first = store.loadConversationId()

		identity.saveBlob("{\"appToken\":\"other\",\"device\":\"device\"}")

		assertNotEquals(first, store.loadConversationId())
	}

	@Test
	fun clearingDropsTheRememberedId() {
		val store = testStore()
		val identity = door(store)
		identity.saveBlob(blob)
		val previous = store.loadConversationId()

		identity.clear()

		assertNull(store.loadConversationId())
		identity.saveBlob(blob)
		assertNotEquals(previous, store.loadConversationId())
	}

	@Test
	fun deviceNameNormalizesRouterDisallowedCharacters() {
		val credentials = ConsoleCredentials.parse("{\"device\":\"pixel/pro\\r\\nmodel\"}", testStore())

		assertEquals("pixel-pro--model", credentials.device)
	}

	@Test
	fun deviceNameIsLimitedTo64Characters() {
		val credentials = ConsoleCredentials.parse("{\"device\":\"${"x".repeat(65)}\"}", testStore())

		assertEquals(64, credentials.device.length)
	}

	@Test
	fun emptyDeviceNameFallsBackToAndroid() {
		val credentials = ConsoleCredentials.parse("{\"device\":\"\"}", testStore())

		assertEquals("android", credentials.device)
	}
}
