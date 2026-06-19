package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Unit tests for the one-time blob->store stts credential migration decision
 * (sttsMigrationSeed). Pure-JVM (no Robolectric): builds a Provisioning directly
 * rather than Provisioning.parse, so it never touches android.os.Build.
 */
class SttsMigrationTest {
	private fun prov(url: String, key: String) = Provisioning(
		apiUrl = "https://api",
		caPem = "ca",
		saToken = "sa",
		appToken = "app",
		namespace = "evie-bot",
		service = "svc",
		port = 20004,
		device = "dev",
		conversationId = "cid",
		sttsUrl = url,
		sttsKey = key,
	)

	@Test
	fun legacyBlobWithSttsSeedsBoth() {
		val seed = sttsMigrationSeed(prov("https://h", "k"))
		assertEquals("https://h", seed.url)
		assertEquals("k", seed.key)
	}

	@Test
	fun credsLessBlobSeedsNothing() {
		// The regressed cohort: a re-provisioned, creds-less blob carries nothing.
		val seed = sttsMigrationSeed(prov("", ""))
		assertNull(seed.url)
		assertNull(seed.key)
	}

	@Test
	fun absentBlobSeedsNothing() {
		val seed = sttsMigrationSeed(null)
		assertNull(seed.url)
		assertNull(seed.key)
	}

	@Test
	fun partialCredsCarryOnlyTheNonEmptyField() {
		val seed = sttsMigrationSeed(prov("https://h", ""))
		assertEquals("https://h", seed.url)
		assertNull(seed.key)
	}
}
