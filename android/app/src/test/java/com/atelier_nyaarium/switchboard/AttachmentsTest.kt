package com.atelier_nyaarium.switchboard

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
}
