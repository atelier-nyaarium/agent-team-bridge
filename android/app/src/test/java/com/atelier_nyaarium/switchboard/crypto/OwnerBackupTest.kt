package com.atelier_nyaarium.switchboard.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The owner-key backup round-trips under the right passphrase and refuses the wrong one
 * (the AES-GCM tag fails), so a stolen blob is useless without the passphrase.
 */
class OwnerBackupTest {
	private val secret = """{"sign":{"pub":"abc","priv":"def"},"box":{"pub":"ghi","priv":"jkl"}}"""

	@Test
	fun roundTripsUnderTheRightPassphrase() {
		val blob = OwnerBackup.export(secret, "correct horse battery staple")
		assertEquals(secret, OwnerBackup.restore(blob, "correct horse battery staple"))
	}

	@Test
	fun rejectsTheWrongPassphrase() {
		val blob = OwnerBackup.export(secret, "correct horse battery staple")
		assertThrows(Exception::class.java) { OwnerBackup.restore(blob, "wrong passphrase") }
	}
}
