package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A `"peer"` mailbox entry mirrors an agent-to-agent exchange into a thread that isn't a party to
 * it in the usual sense - the true author varies per row instead of collapsing to the thread's
 * one fixed peer. These tests cover the drain-routing decision (`resolveMessageAttribution`) and
 * the persistence round-trip (`persistedAttribution`/`loadedAttribution`) that keep a peer row's
 * real sender intact across an app restart, keyed on `isPeer` rather than `to`'s presence so a
 * peer row with an unresolvable `to` still keeps its real `from`.
 *
 * Pure function tests, no Android context (no Robolectric).
 */
class PeerMirrorAttributionTest {

	// -- resolveMessageAttribution: drain-routing decision --

	@Test
	fun ordinaryEntryCollapsesToTheThreadsFixedPeer() {
		val a = resolveMessageAttribution(
			kind = "message",
			entryFrom = "alice.sakura.coolapp.main",
			entryTo = null,
			team = "alice.sakura.coollib.main",
			canonicalize = { it },
		)
		assertEquals("alice.sakura.coollib.main", a.from)
		assertNull(a.to)
		assertFalse(a.isPeer)
	}

	@Test
	fun peerEntryUsesItsOwnFromAndToInsteadOfTheThread() {
		val a = resolveMessageAttribution(
			kind = "peer",
			entryFrom = "alice.sakura.coolapp.main",
			entryTo = "alice.sakura.coollib.main",
			team = "alice.sakura.coollib.main",
			canonicalize = { it },
		)
		// Filed under coollib's own thread, but the actual author was coolapp - not the thread itself.
		assertEquals("alice.sakura.coolapp.main", a.from)
		assertEquals("alice.sakura.coollib.main", a.to)
		assertTrue(a.isPeer)
	}

	@Test
	fun peerEntryShowsAnUnresolvableFromRawInsteadOfForgingTheThreadKey() {
		// The thread key is a real identity (the target), so substituting it forges the sender -
		// the same family as stamping the route Gateway onto a bare relayed name. An unparseable
		// name shown raw is honest; a plausible wrong identity is not.
		val a = resolveMessageAttribution(
			kind = "peer",
			entryFrom = "not-an-address",
			entryTo = "alice.sakura.coollib.main",
			team = "alice.sakura.coolapp.main",
			canonicalize = { null },
		)
		assertEquals("not-an-address", a.from)
		assertTrue(a.isPeer)
	}

	@Test
	fun peerEntryStaysMarkedAsPeerEvenWhenOnlyToFailsToResolve() {
		// A real, resolved from paired with an unresolvable to must still persist as a peer row, never
		// fall back to an ordinary one. The unresolvable to is kept raw, same honesty rule as from.
		val a = resolveMessageAttribution(
			kind = "peer",
			entryFrom = "alice.sakura.coolapp.main",
			entryTo = "not-an-address",
			team = "alice.sakura.coollib.main",
			canonicalize = { s -> s.takeIf { it == "alice.sakura.coolapp.main" } },
		)
		assertEquals("alice.sakura.coolapp.main", a.from)
		assertEquals("not-an-address", a.to)
		assertTrue(a.isPeer)
	}

	// -- persistedAttribution: what gets written --

	@Test
	fun anOrdinaryRowPersistsNeitherFromNorTo() {
		val msg = Message(fromMe = false, text = "hi", at = 1000L, from = "alice.sakura.coollib.main")
		val (persistFrom, persistTo) = persistedAttribution(msg)
		assertNull(persistFrom)
		assertNull(persistTo)
	}

	@Test
	fun aPeerRowPersistsBothFromAndToVerbatim() {
		val msg = Message(
			fromMe = false,
			text = "hi",
			at = 1000L,
			from = "alice.sakura.coolapp.main",
			to = "alice.sakura.coollib.main",
			isPeer = true,
		)
		val (persistFrom, persistTo) = persistedAttribution(msg)
		assertEquals("alice.sakura.coolapp.main", persistFrom)
		assertEquals("alice.sakura.coollib.main", persistTo)
	}

	@Test
	fun aPeerRowWithNoResolvedToStillPersistsItsRealFrom() {
		// The bug this pins: inferring peer-ness from to's presence would have discarded a real
		// from here just because to came back null.
		val msg = Message(fromMe = false, text = "hi", at = 1000L, from = "alice.sakura.coolapp.main", to = null, isPeer = true)
		val (persistFrom, persistTo) = persistedAttribution(msg)
		assertEquals("alice.sakura.coolapp.main", persistFrom)
		assertNull(persistTo)
	}

	// -- loadedAttribution: what a reload rebuilds --

	@Test
	fun ownRowLoadsWithNoAuthor() {
		val (from, to) = loadedAttribution(
			persistedFrom = null,
			persistedTo = null,
			isPeer = false,
			isMe = true,
			canonicalKey = "alice.sakura.coollib.main",
		)
		assertNull(from)
		assertNull(to)
	}

	@Test
	fun ordinaryRowReDerivesItsAuthorFromTheThreadKey() {
		val (from, to) = loadedAttribution(
			persistedFrom = null,
			persistedTo = null,
			isPeer = false,
			isMe = false,
			canonicalKey = "alice.sakura.coollib.main",
		)
		assertEquals("alice.sakura.coollib.main", from)
		assertNull(to)
	}

	@Test
	fun peerRowSurvivesAReloadWithItsRealSenderNotTheThreadsPeer() {
		// The thread key here is coollib's own address, but the row's real author was coolapp -
		// a reload must not stomp that back to canonicalKey the way an ordinary row's does.
		val (from, to) = loadedAttribution(
			persistedFrom = "alice.sakura.coolapp.main",
			persistedTo = "alice.sakura.coollib.main",
			isPeer = true,
			isMe = false,
			canonicalKey = "alice.sakura.coollib.main",
		)
		assertEquals("alice.sakura.coolapp.main", from)
		assertEquals("alice.sakura.coollib.main", to)
	}

	@Test
	fun peerRowWithNoPersistedFromFallsBackToTheThreadKey() {
		// persistedTo is deliberately distinct from canonicalKey: a fallback that mixed up which
		// one to use for `from` would fail this, where a same-value fixture could not catch it.
		val (from, _) = loadedAttribution(
			persistedFrom = null,
			persistedTo = "alice.sakura.other.main",
			isPeer = true,
			isMe = false,
			canonicalKey = "alice.sakura.coollib.main",
		)
		assertEquals("alice.sakura.coollib.main", from)
	}

	@Test
	fun peerRowWithNoPersistedToStillKeepsItsRealFromInsteadOfTheThreadKey() {
		// The load-side half of the same bug this pins on the persist side: isPeer, not to's
		// presence, must gate whether from re-derives from the thread key.
		val (from, to) = loadedAttribution(
			persistedFrom = "alice.sakura.coolapp.main",
			persistedTo = null,
			isPeer = true,
			isMe = false,
			canonicalKey = "alice.sakura.coollib.main",
		)
		assertEquals("alice.sakura.coolapp.main", from)
		assertNull(to)
	}
}
