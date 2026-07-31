package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** How a video's frame set is identified and where it is filed. The bucket name is derived rather
 * than taken from the key, because a src is a URL path and would otherwise shape a directory. */
class VideoThumbsKeyTest {
	private fun video(src: String? = null, blobId: String? = null) =
		MessageFile("clip.mp4", "video/mp4", src, blobId = blobId)

	@Test
	fun theSameBytesShareOneSetHoweverTheyWereFiled() {
		val blob = "sha256-${"c".repeat(64)}"

		assertEquals(
			VideoThumbs.keyFor(video("5-12/clip.mp4", blob)),
			VideoThumbs.keyFor(video("9-3/clip.mp4", blob)),
		)
	}

	@Test
	fun aPickedVideoFallsBackToItsPathBecauseItHasNoBlobIdYet() {
		// blobId is stamped when the message is SENT, so keying on it alone would leave every draft
		// video re-extracting its frames on each look.
		assertEquals("draft-1/clip.mp4", VideoThumbs.keyFor(video("draft-1/clip.mp4")))
		assertNotEquals(
			VideoThumbs.keyFor(video("draft-1/clip.mp4")),
			VideoThumbs.keyFor(video("draft-2/clip.mp4")),
		)
	}

	@Test
	fun aVideoNamingNeitherBytesNorAPathHasNoSetAtAll() {
		assertNull(VideoThumbs.keyFor(video()))
		assertNull(VideoThumbs.keyFor(video("", "")))
	}

	@Test
	fun aBucketNameCannotBeShapedByThePathItCameFrom() {
		// A src is a URL path. Used directly it would create nested directories, or worse, escape.
		val bucket = VideoThumbs.bucketFor("../../etc/passwd")

		assertTrue("bucket was $bucket", bucket.matches(Regex("frames-[0-9a-f]+")))
	}

	@Test
	fun differentKeysGetDifferentBuckets() {
		assertNotEquals(VideoThumbs.bucketFor("a"), VideoThumbs.bucketFor("b"))
		assertEquals(VideoThumbs.bucketFor("a"), VideoThumbs.bucketFor("a"))
	}
}
