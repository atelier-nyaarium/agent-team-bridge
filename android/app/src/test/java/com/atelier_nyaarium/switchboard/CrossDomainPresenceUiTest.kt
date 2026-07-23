package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceKnownVersion
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
		val result = upsertKnownCrossDomainPresenceVersions(emptyList(), listOf(entry("alice"), entry("bob")))
		assertEquals(setOf("alice", "bob"), result.map { it.domainId }.toSet())
	}

	@Test
	fun matchingDomainIsReplacedNotDuplicated() {
		val current = listOf(CrossDomainPresenceKnownVersion("alice", epoch = 1, version = 1))
		val result = upsertKnownCrossDomainPresenceVersions(current, listOf(entry("alice", epoch = 1, version = 2)))
		assertEquals(listOf(CrossDomainPresenceKnownVersion("alice", epoch = 1, version = 2)), result)
	}

	@Test
	fun otherKnownDomainsSurviveAPartialUpdate() {
		// The wire only ships the CHANGED subset - "bob" not appearing in `entries` must not drop it.
		val current = listOf(
			CrossDomainPresenceKnownVersion("alice", epoch = 1, version = 1),
			CrossDomainPresenceKnownVersion("bob", epoch = 1, version = 5),
		)
		val result = upsertKnownCrossDomainPresenceVersions(current, listOf(entry("alice", epoch = 1, version = 2)))
		assertEquals(
			setOf(
				CrossDomainPresenceKnownVersion("alice", epoch = 1, version = 2),
				CrossDomainPresenceKnownVersion("bob", epoch = 1, version = 5),
			),
			result.toSet(),
		)
	}
}
