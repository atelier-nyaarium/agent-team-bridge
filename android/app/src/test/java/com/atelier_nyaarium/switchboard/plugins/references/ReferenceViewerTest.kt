package com.atelier_nyaarium.switchboard.plugins.references

import com.atelier_nyaarium.switchboard.proto.RefFileMeta
import com.atelier_nyaarium.switchboard.proto.RefKeyMeta
import com.atelier_nyaarium.switchboard.proto.RefSegmentMeta
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ReferenceViewerTest {

	@get:Rule
	val tmp = TemporaryFolder()

	private fun key(
		quality: String = "exact",
		reason: String? = null,
		ambiguous: Boolean? = null,
		matchCount: Long? = null,
	) = RefKeyMeta(
		key = "ref://src/cart.ts:Cart:add",
		startLine = 100,
		endLine = 110,
		quality = quality,
		reason = reason,
		ambiguous = ambiguous,
		matchCount = matchCount,
	)

	private fun request(meta: RefFileMeta, k: RefKeyMeta = key()) =
		ReferenceOpenRequest("team", k, meta, "1-1/cart.ts", "ref://src/cart.ts:Cart:add")

	private fun segmentsOf(payload: String): List<Pair<Long, String>> {
		val arr = JSONObject(payload).getJSONArray("segments")
		return (0 until arr.length()).map { i ->
			val s = arr.getJSONObject(i)
			s.getLong("startLine") to s.getString("text")
		}
	}


	@Test
	fun aSnapshotWithNoSegmentsRendersWholeNumberedFromOne() {
		val snapshot = tmp.newFile().apply { writeText("a\nb\nc") }
		val payload = payloadFor(request(RefFileMeta("src/cart.ts", segments = null, keys = listOf(key()))), snapshot)
		assertEquals(listOf(1L to "a\nb\nc"), segmentsOf(payload))
	}

	@Test
	fun declaredLineCountsSliceTheJoinedSnapshotBackIntoTheOriginalSegments() {
		// Declared counts must invert the producer's newline join.
		val first = "fun a() {\n\treturn 1\n}"
		val second = "fun z() {\n\treturn 26\n}"
		val snapshot = tmp.newFile().apply { writeText("$first\n$second") }
		val meta = RefFileMeta(
			"src/cart.ts",
			segments = listOf(RefSegmentMeta(startLine = 97, lineCount = 3), RefSegmentMeta(startLine = 300, lineCount = 3)),
			keys = listOf(key()),
		)
		assertEquals(listOf(97L to first, 300L to second), segmentsOf(payloadFor(request(meta), snapshot)))
	}

	@Test
	fun aLyingLineCountClampsToWhatExistsRatherThanThrowing() {
		val snapshot = tmp.newFile().apply { writeText("only\ntwo") }
		val meta = RefFileMeta(
			"src/cart.ts",
			segments = listOf(RefSegmentMeta(startLine = 1, lineCount = 999)),
			keys = listOf(key()),
		)
		assertEquals(listOf(1L to "only\ntwo"), segmentsOf(payloadFor(request(meta), snapshot)))
	}

	@Test
	fun segmentsPastAnExhaustedSnapshotDegradeToEmptyText() {
		val snapshot = tmp.newFile().apply { writeText("a\nb") }
		val meta = RefFileMeta(
			"src/cart.ts",
			segments = listOf(RefSegmentMeta(startLine = 1, lineCount = 2), RefSegmentMeta(startLine = 50, lineCount = 4)),
			keys = listOf(key()),
		)
		assertEquals(listOf(1L to "a\nb", 50L to ""), segmentsOf(payloadFor(request(meta), snapshot)))
	}


	@Test
	fun anExactResolutionShowsNoBanner() {
		assertNull(noticeFor(key()))
	}

	@Test
	fun aFuzzyResolutionExplainsItselfWithItsReasonWhenCarried() {
		assertEquals("renamed", noticeFor(key(quality = "fuzzy", reason = "renamed")))
		assertNotNull(noticeFor(key(quality = "fuzzy")))
	}

	@Test
	fun anUnresolvedResolutionFallsBackToItsOwnWording() {
		val unresolved = noticeFor(key(quality = "unresolved"))
		assertNotNull(unresolved)
		assertNotEquals(noticeFor(key(quality = "fuzzy")), unresolved)
	}

	@Test
	fun ambiguityPrintsItsCountOrNothingNeverTheWordNull() {
		assertTrue(noticeFor(key(ambiguous = true, matchCount = 3))!!.contains("3"))
		// An ambiguity flag without a count renders no notice.
		assertNull(noticeFor(key(ambiguous = true, matchCount = null)))
	}
}
