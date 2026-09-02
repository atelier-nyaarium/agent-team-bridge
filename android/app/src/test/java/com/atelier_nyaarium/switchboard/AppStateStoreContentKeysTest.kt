package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.Base64

class AppStateStoreContentKeysTest {
	@Test
	fun plainStoreRefusesPrivateKeyWrites() {
		val store = plainStore()
		val identity = Crypto.generateIdentity()
		assertThrows(IllegalStateException::class.java) { store.saveContentKeys(mapOf(1 to ByteArray(32))) }
		assertThrows(IllegalStateException::class.java) { store.saveIdentity(identity) }
		assertThrows(IllegalStateException::class.java) { store.saveOwnerIdentity(identity) }
		assertEquals(ContentKeysLoad.Absent, store.loadContentKeys())
	}

	@Test
	fun validAndCorruptContentKeySlotsClassify() {
		val store = testStore()
		val first = ByteArray(32) { 1 }
		val second = ByteArray(32) { 2 }
		store.saveContentKeys(mapOf(1 to first, 2 to second))
		val loaded = store.loadContentKeys() as ContentKeysLoad.Loaded
		assertArrayEquals(first, loaded.keys.getValue(1))
		assertArrayEquals(second, loaded.keys.getValue(2))

		val prefs = TestPreferences()
		val seededStore = AppStateStore(java.io.File("/tmp/switchboard-test"), prefs, encrypted = false)
		prefs.edit().putString(
			AppStateStore.KEY_CONTENT_KEYS,
			"{\"1\":\"${Base64.getEncoder().encodeToString(first)}\"}",
		).apply()
		assertArrayEquals(first, (seededStore.loadContentKeys() as ContentKeysLoad.Loaded).keys.getValue(1))

		val corruptStore = AppStateStore(java.io.File("/tmp/switchboard-test"), prefs, encrypted = true)
		prefs.edit().putString(AppStateStore.KEY_CONTENT_KEYS, "{ not json").apply()
		assertTrue(corruptStore.loadContentKeys() is ContentKeysLoad.Corrupt)
		prefs.edit().putString(
			AppStateStore.KEY_CONTENT_KEYS,
			"{\"1\":\"${Base64.getEncoder().encodeToString(ByteArray(31))}\"}",
		).apply()
		assertTrue(corruptStore.loadContentKeys() is ContentKeysLoad.Corrupt)
	}
}
