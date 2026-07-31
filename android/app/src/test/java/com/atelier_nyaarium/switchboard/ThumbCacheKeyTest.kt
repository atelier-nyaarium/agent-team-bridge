package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The cache is shared by two producers drawing keys from different spaces, so what keeps their
 * bitmaps apart is the only part worth pinning. */
class ThumbCacheKeyTest {
	@Test
	fun aCardAndAnImageCannotCollideEvenOnAnIdenticalReference() {
		val same = "5-12/thing.png"

		assertNotEquals(ThumbCache.card(same), ThumbCache.image(null, same))
	}

	@Test
	fun contentAddressedBytesWinSoTheSameFileTwiceIsOneEntry() {
		val blob = "sha256-${"a".repeat(64)}"

		// Two rows for the same bytes reach the same entry regardless of where each was filed.
		assertEquals(ThumbCache.image(blob, "5-12/a.png"), ThumbCache.image(blob, "9-3/b.png"))
	}

	@Test
	fun aPickedFileFallsBackToItsPathBecauseItHasNoBlobIdYet() {
		// blobId is computed when a message is SENT, so a draft file has none. Keying on blobId alone
		// would leave every draft thumbnail uncacheable.
		assertEquals(ThumbCache.image(null, "out-1/photo.png"), ThumbCache.image("", "out-1/photo.png"))
		assertNotEquals(ThumbCache.image(null, "out-1/photo.png"), ThumbCache.image(null, "out-2/photo.png"))
	}

	@Test
	fun aFileNamingNeitherBytesNorAPathHasNoKeyAtAll() {
		assertNull(ThumbCache.image(null, null))
		assertNull(ThumbCache.image("", ""))
		assertNull(ThumbCache.image("  ", null))
	}
}
