package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceVersion
import org.junit.Assert.assertEquals
import org.junit.Test

class CrossDomainPresenceUiTest {
	private fun entry(domainId: String, epoch: Long = 1, version: Long = 1, lastRefreshedAt: Long = 0) =
		CrossDomainPresenceEntry(
			domainId = domainId,
			version = CrossDomainPresenceVersion(epoch, version),
			sessions = emptyList(),
			lastRefreshedAt = lastRefreshedAt,
		)

	// -- crossDomainFreshness --

	@Test
	fun nullTimestampIsUnknown() {
		assertEquals(CrossDomainFreshness.UNKNOWN, crossDomainFreshness(null, now = 1_000_000))
	}

	@Test
	fun withinThresholdIsFresh() {
		val now = 1_000_000L
		assertEquals(
			CrossDomainFreshness.FRESH,
			crossDomainFreshness(now - CROSS_DOMAIN_STALE_THRESHOLD_MS, now, CROSS_DOMAIN_STALE_THRESHOLD_MS),
		)
	}

	@Test
	fun pastThresholdIsStale() {
		val now = 1_000_000L
		assertEquals(
			CrossDomainFreshness.STALE,
			crossDomainFreshness(now - CROSS_DOMAIN_STALE_THRESHOLD_MS - 1, now, CROSS_DOMAIN_STALE_THRESHOLD_MS),
		)
	}

	// -- upsertKnownCrossDomainPresenceVersions --

	@Test
	fun emptyCurrentAdoptsAllIncomingEntries() {
		val result = upsertKnownCrossDomainPresenceVersions(emptyMap(), listOf(entry("alice"), entry("bob")))
		assertEquals(mapOf("alice" to 1L, "bob" to 1L), result)
	}

	@Test
	fun matchingDomainIsReplacedNotDuplicated() {
		val current = mapOf("alice" to 1L)
		val result = upsertKnownCrossDomainPresenceVersions(current, listOf(entry("alice", epoch = 1, version = 2)))
		assertEquals(mapOf("alice" to 2L), result)
	}

	@Test
	fun otherKnownDomainsSurviveAPartialUpdate() {
		// The wire only ships the CHANGED subset - "bob" not appearing in `entries` must not drop it.
		val current = mapOf("alice" to 1L, "bob" to 5L)
		val result = upsertKnownCrossDomainPresenceVersions(current, listOf(entry("alice", epoch = 1, version = 2)))
		assertEquals(mapOf("alice" to 2L, "bob" to 5L), result)
	}
}
