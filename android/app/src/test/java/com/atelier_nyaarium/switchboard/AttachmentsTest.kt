package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ChannelFile
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Temp-dir JVM tests for Attachments.deleteFiles and Attachments.sweepOrphanBuckets - no
 * Android API involved (pure java.io), so these run without Robolectric or a Context. */
class AttachmentsTest {
	private lateinit var filesDir: File

	@Before
	fun setUp() {
		filesDir = Files.createTempDirectory("attachments-test").toFile()
	}

	@After
	fun tearDown() {
		filesDir.deleteRecursively()
	}

	private fun write(bucket: String, name: String): String {
		val dir = File(Attachments.root(filesDir), bucket).apply { mkdirs() }
		File(dir, name).writeText("x")
		return "https://appassets.androidplatform.net/${Attachments.DIR}/$bucket/$name"
	}

	// ---- land: the second half of an inbound attachment, after its bytes arrive ----

	@Test
	fun land_putsTheFetchedBytesInTheRowsBucketAndReturnsTheSrcThatRendersThem() {
		val source = File(filesDir, "fetched.bin").apply { writeBytes("real bytes".toByteArray()) }

		val src = Attachments.land(filesDir, Attachments.bucketFor(7, 3), "photo.jpg", source)

		assertEquals("https://appassets.androidplatform.net/${Attachments.DIR}/7-3/photo.jpg", src)
		// Resolvable through the same traversal-guarded path the WebView loads by, not just present.
		assertEquals("real bytes", Attachments.fileFor(filesDir, src)!!.readText())
	}

	@Test
	fun land_leavesNoTmpFileBehindForTheOrphanSweepToTripOver() {
		val source = File(filesDir, "fetched.bin").apply { writeBytes("bytes".toByteArray()) }
		Attachments.land(filesDir, Attachments.bucketFor(7, 3), "photo.jpg", source)

		val leftovers = File(Attachments.root(filesDir), "7-3").listFiles()!!.map { it.name }
		assertEquals(listOf("photo.jpg"), leftovers)
	}

	@Test
	fun land_reportsNothingWhenTheBytesCouldNotBeRead() {
		val source = File(filesDir, "missing.bin")

		assertNull(Attachments.land(filesDir, Attachments.bucketFor(1, 1), "photo.jpg", source))
	}

	@Test
	fun land_reportsNothingWhenTheCommitFails() {
		// A src for a file that did not land would mark the row fetched, and a fetched row is never
		// retried, so a failed commit has to stay reportable as a failure rather than becoming a
		// permanent broken image. A directory squatting the target name makes the rename fail for
		// real, rather than testing the earlier read-failure path a second time.
		val source = File(filesDir, "fetched.bin").apply { writeBytes("bytes".toByteArray()) }
		File(File(Attachments.root(filesDir), "1-1"), "photo.jpg").mkdirs()

		assertNull(Attachments.land(filesDir, Attachments.bucketFor(1, 1), "photo.jpg", source))
		// And it cleans up after itself, so the next attempt is not tripping over its own debris.
		val leftovers = File(Attachments.root(filesDir), "1-1").listFiles()!!.map { it.name }
		assertEquals(listOf("photo.jpg"), leftovers)
	}

	@Test
	fun land_isIdempotentSoARepeatedFetchOverwritesRatherThanAccumulates() {
		val source = File(filesDir, "fetched.bin").apply { writeBytes("v1".toByteArray()) }
		val first = Attachments.land(filesDir, Attachments.bucketFor(7, 3), "photo.jpg", source)
		source.writeBytes("v2".toByteArray())
		val second = Attachments.land(filesDir, Attachments.bucketFor(7, 3), "photo.jpg", source)

		assertEquals(first, second)
		assertEquals("v2", Attachments.fileFor(filesDir, second)!!.readText())
		assertEquals(1, File(Attachments.root(filesDir), "7-3").listFiles()!!.size)
	}

	@Test
	fun decodeThenLand_closesTheLoopFromAReferenceToARenderableFile() {
		// The whole inbound contract in one pass: a wire file names bytes and carries no src; landing
		// the fetched bytes is what produces the src. Nothing else in the suite covers this seam.
		val blobId = "sha256-${"a".repeat(64)}"
		val decoded = Attachments.decode(listOf(ChannelFile("shot.png", "image/png", 5, "shot.png", blobId = blobId)))
		assertNull(decoded[0].src)

		val fetched = File(filesDir, "blob.bin").apply { writeBytes("shot!".toByteArray()) }
		val src = Attachments.land(filesDir, Attachments.bucketFor(9, 2), decoded[0].name, fetched)

		assertNotNull(src)
		assertEquals("shot!", Attachments.fileFor(filesDir, src)!!.readText())
	}

	@Test
	fun purgeAll_takesTheBlobStoreTooSoARevokeLeavesNoSecondCopy() {
		// The two roots are siblings, so purging only the rendered copies would keep a complete
		// duplicate of every attachment the device ever handled.
		write("5-12", "photo.jpg")
		val blobs = BlobStore(BlobStore.root(filesDir))
		val id = BlobStore.blobIdFor("secret".toByteArray())
		blobs.write(id, 0, "secret".toByteArray(), true)
		assertNotNull(blobs.path(id))

		Attachments.purgeAll(filesDir)

		assertNull(blobs.path(id))
		assertEquals(0, Attachments.root(filesDir).listFiles()?.size ?: 0)
	}

	// ---- deleteFiles ----

	@Test
	fun deleteFiles_removesTheNamedFileAndLeavesASiblingBucketUntouched() {
		val target = write("5-12", "photo.jpg")
		write("5-13", "other.jpg")
		Attachments.deleteFiles(filesDir, listOf(target))
		assertFalse(Attachments.fileFor(filesDir, target)?.exists() ?: false)
		assertTrue(File(Attachments.root(filesDir), "5-13/other.jpg").exists())
	}

	@Test
	fun deleteFiles_removesTheBucketDirOnceItsLastFileIsGone() {
		val target = write("5-12", "photo.jpg")
		Attachments.deleteFiles(filesDir, listOf(target))
		assertFalse(File(Attachments.root(filesDir), "5-12").exists())
	}

	@Test
	fun deleteFiles_leavesTheBucketDirWhenAnotherFileStillLivesThere() {
		val target = write("5-12", "photo.jpg")
		write("5-12", "second.jpg")
		Attachments.deleteFiles(filesDir, listOf(target))
		assertTrue(File(Attachments.root(filesDir), "5-12").exists())
		assertTrue(File(Attachments.root(filesDir), "5-12/second.jpg").exists())
	}

	@Test
	fun deleteFiles_anEmptySrcListIsANoOp() {
		// A metadata-only file's null src can never reach this function at all - srcs is a
		// List<String>, and every call site already filters with mapNotNull { it.src } before
		// calling in. This only confirms the trivial empty-input case is safe.
		write("5-12", "photo.jpg")
		Attachments.deleteFiles(filesDir, listOf())
		assertTrue(File(Attachments.root(filesDir), "5-12/photo.jpg").exists())
	}

	// ---- sweepOrphanBuckets ----

	@Test
	fun sweep_deletesAnOldUnreferencedBucket() {
		write("5-12", "photo.jpg")
		File(Attachments.root(filesDir), "5-12").setLastModified(1_000L)
		Attachments.sweepOrphanBuckets(filesDir, referencedSrcs = emptyList(), minAgeMs = Attachments.ORPHAN_SWEEP_MIN_AGE_MS)
		assertFalse(File(Attachments.root(filesDir), "5-12").exists())
	}

	@Test
	fun sweep_keepsAReferencedBucketEvenWhenOld() {
		val src = write("5-12", "photo.jpg")
		File(Attachments.root(filesDir), "5-12").setLastModified(1_000L)
		// referencedSrcs takes real srcs (reduced to bucket names via bucketOf internally), not
		// pre-computed bucket names - passing a bare "5-12" here would silently match nothing.
		Attachments.sweepOrphanBuckets(filesDir, referencedSrcs = listOf(src), minAgeMs = Attachments.ORPHAN_SWEEP_MIN_AGE_MS)
		assertTrue(File(Attachments.root(filesDir), "5-12").exists())
	}

	@Test
	fun sweep_skipsABucketYoungerThanTheAgeThreshold() {
		write("5-12", "photo.jpg")
		File(Attachments.root(filesDir), "5-12").setLastModified(System.currentTimeMillis())
		Attachments.sweepOrphanBuckets(filesDir, referencedSrcs = emptyList(), minAgeMs = Attachments.ORPHAN_SWEEP_MIN_AGE_MS)
		assertTrue(File(Attachments.root(filesDir), "5-12").exists())
	}

	@Test
	fun sweep_treatsAZeroMtimeAsUnknownNeverDeleteEligible() {
		write("5-12", "photo.jpg")
		File(Attachments.root(filesDir), "5-12").setLastModified(0L)
		Attachments.sweepOrphanBuckets(filesDir, referencedSrcs = emptyList(), minAgeMs = Attachments.ORPHAN_SWEEP_MIN_AGE_MS)
		assertTrue(File(Attachments.root(filesDir), "5-12").exists())
	}

	@Test
	fun sweep_leavesEverythingAloneWhenNoBucketsExist() {
		Attachments.sweepOrphanBuckets(filesDir, referencedSrcs = emptyList())
		assertEquals(0, Attachments.root(filesDir).listFiles()?.size ?: 0)
	}

	@Test
	fun decode_carriesTheSendersSizeAndDateOnAMetadataOnlyFile() {
		val files = Attachments.decode(
			listOf(ChannelFile("doc.pdf", "application/pdf", 4096, "doc.pdf", modifiedAt = 1785179969544L)),
		)
		assertEquals(4096L, files[0].size)
		assertEquals(1785179969544L, files[0].modifiedAt)
	}

	@Test
	fun decode_leavesAnUnstampedFileWithNoDate() {
		val files = Attachments.decode(listOf(ChannelFile("doc.pdf", "application/pdf", 4096, "doc.pdf")))
		assertNull(files[0].modifiedAt)
	}

	@Test
	fun decode_carriesTheReferenceAndNoSrcSoTheFetchStillHasSomethingToDo() {
		// The drain must not wait on bytes, so a file arrives named but not yet present. The pair
		// (reference, no src) is exactly the work fetchPendingAttachments looks for, and losing the
		// reference here would strand the attachment with nothing left to fetch it by.
		val blobId = "sha256-${"a".repeat(64)}"
		val files = Attachments.decode(listOf(ChannelFile("shot.png", "image/png", 12, "shot.png", blobId = blobId)))
		assertEquals(blobId, files[0].blobId)
		assertNull(files[0].src)
	}

	@Test
	fun decode_leavesAFileNamingNoBytesWithNothingToFetch() {
		val files = Attachments.decode(listOf(ChannelFile("gone.bin", "application/octet-stream", 3, "gone.bin")))
		assertNull(files[0].blobId)
		assertNull(files[0].src)
	}

	@Test
	fun storeOutgoing_measuresTheBytesAndCarriesNoDate() {
		// The picker exposes no dependable modified column, so an outbound file is deliberately
		// unstamped rather than stamped with the moment it was picked.
		val source = File(filesDir, "note.txt").apply { writeBytes(ByteArray(7)) }
		val admitted = OutgoingFiles.admit(source, "note.txt", "text/plain")
		assertTrue("expected admission", admitted is Admission.Granted)
		val files = Attachments.storeOutgoing(
			filesDir,
			bucket = "out-1",
			files = listOf((admitted as Admission.Granted).file),
		)
		assertEquals(7L, files[0].size)
		assertNull(files[0].modifiedAt)
	}
}
