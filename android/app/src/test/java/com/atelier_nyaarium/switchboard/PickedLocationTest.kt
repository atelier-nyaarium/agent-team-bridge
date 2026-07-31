package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What the composer is willing to say about where a picked file came from.
 *
 * The privacy property is the point: one segment, never a chain, so a folder layout or a username
 * cannot ride along even when the provider spells one out.
 */
class PickedLocationTest {
	@Test
	fun namesTheFoldersOwnSegment() {
		assertEquals("Download", PickedLocation.segmentOf("primary:Download/photo.jpg"))
		assertEquals("Pictures", PickedLocation.segmentOf("primary:Pictures/holiday.png"))
	}

	@Test
	fun reportsOnlyTheLastSegmentSoAFolderChainCannotLeak() {
		// A nested pick would otherwise spell out the user's whole layout, which is exactly what the
		// wire is not allowed to carry and what this row deliberately does not show either.
		assertEquals("Taxes", PickedLocation.segmentOf("primary:Documents/Personal/Finance/Taxes/2025.pdf"))
	}

	@Test
	fun saysNothingWhenTheProviderUsesAnOpaqueId() {
		// MediaDocumentsProvider hands back ids like "image:1000000123". There is no folder in that,
		// so the row hides rather than showing a number.
		assertNull(PickedLocation.segmentOf("image:1000000123"))
		assertNull(PickedLocation.segmentOf("msf:42"))
	}

	@Test
	fun saysNothingForAFileSittingAtAVolumeRoot() {
		assertNull(PickedLocation.segmentOf("primary:photo.jpg"))
	}

	@Test
	fun saysNothingForAMalformedId() {
		assertNull(PickedLocation.segmentOf(""))
		assertNull(PickedLocation.segmentOf("nocolon"))
		assertNull(PickedLocation.segmentOf("primary:"))
		assertNull(PickedLocation.segmentOf("primary:/photo.jpg"))
	}
}
