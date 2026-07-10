package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `sessionLeaf` is the fallback `label()` uses for an address with no local/gateway name override.
 * A malformed input must degrade to "?" rather than echoing the raw string back - the only backstop
 * against a corrupted store file or a future grammar change surfacing a full internal
 * domain.gateway.spawn.session address (or worse, garbage) into a notification or thread title.
 */
class SessionLeafTest {
	@Test
	fun aFullAddressYieldsItsSessionSegment() {
		assertEquals("main", sessionLeaf("alice.sakura.coolapp.main"))
	}

	@Test
	fun aSpawnPointYieldsItsSpawnSegment() {
		assertEquals("coolapp", sessionLeaf("alice.sakura.coolapp"))
	}

	@Test
	fun tooManySegmentsDegradesToPlaceholderNotTheRawString() {
		assertEquals("?", sessionLeaf("a.b.c.d.e"))
	}

	@Test
	fun anInvalidSlugSegmentDegradesToPlaceholderNotTheRawString() {
		assertEquals("?", sessionLeaf("Alice.Sakura.Coolapp.Main"))
	}

	@Test
	fun anEmptySegmentDegradesToPlaceholderNotTheRawString() {
		assertEquals("?", sessionLeaf("alice..coolapp.main"))
	}
}
