package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The attachment merge for a `sentEchoMatch` replace, across its three real fold shapes (see
 * SentEchoMatchTest): a fresh mirror must orphan the old outbound bucket, a same-bucket re-drain
 * fold must delete nothing (old and new already agree), and a fresh-seq re-send fold must orphan
 * the earlier inbound bucket instead - never the new one either way.
 */
class SentEchoMergeTest {
	private fun file(name: String, src: String?) = MessageFile(name, "image/jpeg", src)

	@Test
	fun freshMirror_usesTheEchoSrcAndOrphansTheOldOutboundBucket() {
		val old = listOf(file("photo.jpg", "https://appassets.androidplatform.net/attachments/out-1000/photo.jpg"))
		val echo = listOf(file("photo.jpg", "https://appassets.androidplatform.net/attachments/5-12/photo.jpg"))
		val merge = mergeSentEchoFiles(old, echo)
		assertEquals(echo, merge.files)
		assertEquals(listOf("https://appassets.androidplatform.net/attachments/out-1000/photo.jpg"), merge.deleteSrcs)
	}

	@Test
	fun sameBucketReDrainFold_deletesNothing() {
		val src = "https://appassets.androidplatform.net/attachments/5-12/photo.jpg"
		val old = listOf(file("photo.jpg", src))
		val echo = listOf(file("photo.jpg", src))
		val merge = mergeSentEchoFiles(old, echo)
		assertEquals(echo, merge.files)
		assertTrue(merge.deleteSrcs.isEmpty())
	}

	@Test
	fun freshSeqReSendFold_orphansTheEarlierInboundBucketNotTheNewOne() {
		val old = listOf(file("photo.jpg", "https://appassets.androidplatform.net/attachments/5-12/photo.jpg"))
		val echo = listOf(file("photo.jpg", "https://appassets.androidplatform.net/attachments/5-20/photo.jpg"))
		val merge = mergeSentEchoFiles(old, echo)
		assertEquals(echo, merge.files)
		assertEquals(listOf("https://appassets.androidplatform.net/attachments/5-12/photo.jpg"), merge.deleteSrcs)
	}

	@Test
	fun byteless_keepsTheOldSrcInstead() {
		// Defensive: not currently reachable (the mirror always carries bytes), but a byteless echo
		// file must not lose the optimistic row's own copy.
		val oldSrc = "https://appassets.androidplatform.net/attachments/out-1000/photo.jpg"
		val old = listOf(file("photo.jpg", oldSrc))
		val echo = listOf(file("photo.jpg", null))
		val merge = mergeSentEchoFiles(old, echo)
		assertEquals(listOf(file("photo.jpg", oldSrc)), merge.files)
		assertTrue(merge.deleteSrcs.isEmpty())
	}

	@Test
	fun partial_deletesOnlyTheByteBearingFilesOldCopyKeepsTheByteless() {
		val bytesOldSrc = "https://appassets.androidplatform.net/attachments/out-1000/photo.jpg"
		val metaOldSrc = "https://appassets.androidplatform.net/attachments/out-1000/note.txt"
		val old = listOf(file("photo.jpg", bytesOldSrc), file("note.txt", metaOldSrc))
		val echo = listOf(
			file("photo.jpg", "https://appassets.androidplatform.net/attachments/5-12/photo.jpg"),
			file("note.txt", null),
		)
		val merge = mergeSentEchoFiles(old, echo)
		assertEquals(
			listOf(
				file("photo.jpg", "https://appassets.androidplatform.net/attachments/5-12/photo.jpg"),
				file("note.txt", metaOldSrc),
			),
			merge.files,
		)
		assertEquals(listOf(bytesOldSrc), merge.deleteSrcs)
	}

	@Test
	fun anOldFileWithNoEchoCounterpartIsOrphaned() {
		// The row is replaced wholesale with the merged list; a file the echo dropped entirely is
		// no longer referenced by anything and must be deleted.
		val droppedSrc = "https://appassets.androidplatform.net/attachments/out-1000/extra.jpg"
		val old = listOf(file("extra.jpg", droppedSrc))
		val echo = emptyList<MessageFile>()
		val merge = mergeSentEchoFiles(old, echo)
		assertTrue(merge.files.isEmpty())
		assertEquals(listOf(droppedSrc), merge.deleteSrcs)
	}

	@Test
	fun textOnlySend_noFilesEitherSideIsANoOp() {
		val merge = mergeSentEchoFiles(emptyList(), emptyList())
		assertTrue(merge.files.isEmpty())
		assertTrue(merge.deleteSrcs.isEmpty())
	}

	@Test
	fun pairsByNameNotByPosition() {
		// A byteless echo keeps the OLD row's src for the SAME NAME - if pairing were positional
		// instead of by-name, a reordered list would attach the wrong old src to the wrong name.
		val aSrc = "https://appassets.androidplatform.net/attachments/out-1000/a.jpg"
		val bSrc = "https://appassets.androidplatform.net/attachments/out-1000/b.jpg"
		val old = listOf(file("a.jpg", aSrc), file("b.jpg", bSrc))
		// echo lists the same two names in the OPPOSITE order, both byteless.
		val echo = listOf(file("b.jpg", null), file("a.jpg", null))
		val merge = mergeSentEchoFiles(old, echo)
		assertEquals(listOf(file("b.jpg", bSrc), file("a.jpg", aSrc)), merge.files)
		assertTrue(merge.deleteSrcs.isEmpty())
	}
}
