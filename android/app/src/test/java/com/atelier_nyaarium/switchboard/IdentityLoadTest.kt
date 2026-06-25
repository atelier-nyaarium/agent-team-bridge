package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the absent-vs-corrupt-vs-loaded classification the fail-closed identity gate rests on.
 * A persisted key that is present but does not decode MUST classify Corrupt (never Absent), so
 * the mint path never overwrites it and silently re-roots the device. Pure JVM (no Android
 * Context): the decode is the security-relevant part, the prefs read is a thin wrapper.
 */
class IdentityLoadTest {
	@Test
	fun nullBytesAreAbsent() {
		assertEquals(IdentityLoad.Absent, IdentityLoad.classify(null))
	}

	@Test
	fun presentButUndecodableBytesAreCorrupt() {
		// A truncated / garbage blob is the dangerous case: it must NOT read as Absent (which mints).
		assertEquals(IdentityLoad.Corrupt, IdentityLoad.classify("{ not json"))
	}

	@Test
	fun validJsonWithMissingFieldsIsCorrupt() {
		// Parses as JSON but is not a full Identity (missing the box keypair): still Corrupt, not Absent.
		assertEquals(IdentityLoad.Corrupt, IdentityLoad.classify("""{"sign":{"pub":"x","priv":"y"}}"""))
	}

	@Test
	fun emptyStringIsCorrupt() {
		// An empty string is PRESENT bytes (not null), so it is a decode failure, not Absent.
		assertEquals(IdentityLoad.Corrupt, IdentityLoad.classify(""))
	}

	@Test
	fun aRoundTrippedIdentityLoads() {
		val id = Crypto.generateIdentity()
		val json = wireJson.encodeToString(Crypto.Identity.serializer(), id)
		val load = IdentityLoad.classify(json)
		assertTrue(load is IdentityLoad.Loaded)
		assertEquals(id.sign.pub, (load as IdentityLoad.Loaded).identity.sign.pub)
		assertEquals(id.box.pub, load.identity.box.pub)
	}
}
