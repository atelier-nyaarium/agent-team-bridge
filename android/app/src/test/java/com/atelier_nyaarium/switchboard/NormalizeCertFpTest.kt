package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Unit tests for normalizeCertFp: the hand-typed Router fingerprint's only entry point. The pin
 * check compares plain lowercase hex, so anything this lets through un-normalized fails later as
 * an opaque cert mismatch rather than here as a typo.
 */
class NormalizeCertFpTest {

	private val plain = "ce8c1377542a9a45e2f084d6b17bf5a87f68dd92f6baa05aa4f302d27adc1a7c"

	@Test
	fun acceptsTheColonSeparatedSpellingOpensslPrints() {
		val colons = plain.chunked(2).joinToString(":").uppercase()
		assertEquals(plain, normalizeCertFp(colons))
	}

	@Test
	fun acceptsSurroundingWhitespaceAndMixedCase() {
		assertEquals(plain, normalizeCertFp("  ${plain.uppercase()}  "))
	}

	@Test
	fun rejectsATruncatedPaste() {
		assertNull(normalizeCertFp(plain.dropLast(1)))
	}

	@Test
	fun rejectsNonHex() {
		assertNull(normalizeCertFp(plain.dropLast(1) + "z"))
	}
}
