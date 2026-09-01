package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceKnownVersion

/**
 * Pure helpers for the cross-Domain-presence UI (a linked friend's live sessions, pushed/pulled via
 * the Gateway's crossDomainPresence poll plane - see PresenceOps.applyCrossDomainPresence). Kept
 * Android-free so a JVM unit test can pin the upsert and freshness rules without a full repository.
 */

////////////////////////////////
//  Interfaces & Types

/** How recently a Domain's cross-Domain-presence entry was confirmed accurate by the Gateway (a
 * landed push OR a successful backstop pull - either refreshes `lastRefreshedAt` identically, see
 * AGENTS.md's own doc on the wire field). Computed client-side against a threshold, never shipped as
 * a boolean on the wire. */
enum class CrossDomainFreshness {
	/** Refreshed within the threshold - shown as the friend's live state. */
	FRESH,

	/** Refreshed once, but not recently enough to trust as current. */
	STALE,

	/** Nothing has landed for this Domain yet (linked, but no push/pull has arrived this session). */
	UNKNOWN,
}

////////////////////////////////
//  Functions & Helpers

/** How long since a Domain's last confirmed refresh before its entry is shown as STALE rather than
 * FRESH. Comfortably above both the Gateway's ~10s backstop-pull cadence and its own up-to-60s
 * freshness-bucketing delay (see crossDomainPresence.ts's FRESHNESS_BUCKET_MS), so ordinary backstop
 * timing never flashes a falsely-stale chip. */
const val CROSS_DOMAIN_STALE_THRESHOLD_MS = 5 * 60_000L

/** FRESH if `lastRefreshedAt` is within `staleThresholdMs` of `now`; STALE if older; UNKNOWN if there
 * is nothing to judge (no entry has landed for this Domain yet). */
fun crossDomainFreshness(
	lastRefreshedAt: Long?,
	now: Long,
	staleThresholdMs: Long = CROSS_DOMAIN_STALE_THRESHOLD_MS,
): CrossDomainFreshness =
	when {
		lastRefreshedAt == null -> CrossDomainFreshness.UNKNOWN
		now - lastRefreshedAt <= staleThresholdMs -> CrossDomainFreshness.FRESH
		else -> CrossDomainFreshness.STALE
	}

/** Fold a batch of CHANGED cross-Domain-presence entries into the existing known-versions list via a
 * per-domainId upsert (replace if present, else append) - never a wholesale replace, since a poll
 * response only ever carries the SUBSET of linked Domains whose plane actually changed. Replacing
 * the whole list on one response would forget every OTHER already-known Domain's version, making the
 * Gateway needlessly re-ship them as "unknown" on the next poll. */
fun upsertKnownCrossDomainPresenceVersions(
	current: List<CrossDomainPresenceKnownVersion>,
	entries: List<CrossDomainPresenceEntry>,
): List<CrossDomainPresenceKnownVersion> {
	val byDomain = current.associateByTo(LinkedHashMap()) { it.domainId }
	for (e in entries) {
		byDomain[e.domainId] = CrossDomainPresenceKnownVersion(e.domainId, e.version.epoch, e.version.version)
	}
	return byDomain.values.toList()
}
