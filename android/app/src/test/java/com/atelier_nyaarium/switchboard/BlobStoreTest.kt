package com.atelier_nyaarium.switchboard

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The Kotlin half of the blob-store conformance corpus. This suite and the vitest one read the
 * SAME `tests/fixtures/blob/_manifest.json`, so a chunk-boundary or digest rule cannot end up
 * honored by only one runtime.
 */
class BlobStoreTest {
	private lateinit var root: File
	private lateinit var store: BlobStore

	@Before
	fun setUp() {
		root = Files.createTempDirectory("blobs-test").toFile()
		store = BlobStore(root)
	}

	@After
	fun tearDown() {
		root.deleteRecursively()
	}

	private fun corpus(): List<JSONObject> {
		// Read as a test resource, not a relative path: build.gradle.kts already mounts the repo's
		// shared `tests/fixtures` for exactly this, and it is how ProtocolFixturesTest reaches its
		// own corpus. A path relative to cwd would depend on which directory Gradle happened to
		// launch the test from.
		val text = javaClass.classLoader!!.getResourceAsStream("blob/_manifest.json")
			?.bufferedReader()?.readText()
		assertTrue("shared blob corpus not on the test classpath", text != null)
		val arr = JSONObject(text!!).getJSONArray("cases")
		return (0 until arr.length()).map { arr.getJSONObject(it) }
	}

	@Test
	fun corpusBlobIdsAgreeWithThisRuntimesDigest() {
		for (c in corpus()) {
			assertEquals(
				c.getString("name"),
				c.getString("blobId"),
				BlobStore.blobIdFor(c.getString("content").toByteArray()),
			)
		}
	}

	@Test
	fun everyCorpusCaseBehavesAsDeclared() {
		for (c in corpus()) {
			val name = c.getString("name")
			val blobId = c.getString("blobId")
			val content = c.getString("content")
			val expect = c.getString("expect")
			val corrupt = if (c.has("corruptLastChunkTo")) c.getString("corruptLastChunkTo") else null
			val chunks = c.getJSONArray("chunks")

			var threw = false
			for (i in 0 until chunks.length()) {
				val chunk = chunks.getJSONObject(i)
				val last = i == chunks.length() - 1
				val text = if (last && corrupt != null) corrupt else chunk.getString("text")
				try {
					store.write(blobId, chunk.getLong("offset"), text.toByteArray(), chunk.getBoolean("final"))
				} catch (_: IllegalArgumentException) {
					threw = true
					break
				}
			}

			when (expect) {
				"throws" -> {
					assertTrue("$name: expected a refused gap", threw)
					assertTrue("$name: must not be readable", !store.stat(blobId).complete)
					assertNull("$name: must expose no path", store.path(blobId))
				}
				"rejected" -> {
					// Bytes that do not hash to the name they claim never become readable.
					assertTrue("$name: must not complete", !store.stat(blobId).complete)
					assertNull("$name: must expose no path", store.path(blobId))
				}
				"complete" -> {
					val stat = store.stat(blobId)
					assertTrue("$name: expected complete", stat.complete)
					assertEquals("$name: have", content.toByteArray().size.toLong(), stat.have)
					assertEquals("$name: content", content, store.path(blobId)!!.readText())
				}
				else -> throw AssertionError("$name: unknown expect $expect")
			}
			store.remove(blobId)
		}
	}

	@Test
	fun haveIsTheResumeCursorWhileATransferIsOpen() {
		val content = "resume me please"
		val id = BlobStore.blobIdFor(content.toByteArray())
		assertEquals(0L, store.stat(id).have)
		store.write(id, 0, content.substring(0, 6).toByteArray(), false)
		assertEquals(6L, store.stat(id).have)
		store.write(id, 6, content.substring(6).toByteArray(), true)
		assertTrue(store.stat(id).complete)
	}

	@Test
	fun readsARangeRatherThanTheWholeBlob() {
		val content = "0123456789"
		val id = BlobStore.blobIdFor(content.toByteArray())
		store.write(id, 0, content.toByteArray(), true)
		assertEquals("2345", String(store.read(id, 2, 4).bytes))
		assertTrue(!store.read(id, 2, 4).eof)
		assertEquals("89", String(store.read(id, 8, 4).bytes))
		assertTrue(store.read(id, 8, 4).eof)
	}

	@Test
	fun refusesAPathForAnIncompleteBlob() {
		val id = BlobStore.blobIdFor("not finished yet".toByteArray())
		store.write(id, 0, "not fin".toByteArray(), false)
		assertNull(store.path(id))
	}

	// ---- pruneStale: the store is a transfer buffer on this device, so residue has to go ----

	@Test
	fun pruneStaleReclaimsResidueOlderThanTheWindow() {
		val id = BlobStore.blobIdFor("abandoned".toByteArray())
		store.write(id, 0, "aband".toByteArray(), false)

		// now far enough ahead that anything on disk counts as stale.
		val freed = store.pruneStale(maxAgeMs = 1000, now = System.currentTimeMillis() + 10_000)

		assertEquals(5L, freed)
		assertEquals(0L, store.stat(id).have)
	}

	@Test
	fun pruneStaleLeavesALiveTransferAlone() {
		val id = BlobStore.blobIdFor("in flight".toByteArray())
		store.write(id, 0, "in ".toByteArray(), false)

		assertEquals(0L, store.pruneStale(maxAgeMs = 3_600_000))
		assertEquals(3L, store.stat(id).have)
	}

	@Test
	fun pruneStaleTreatsAnUnreadableTimestampAsUnknownRatherThanAncient() {
		// 0L is lastModified's I/O-failure sentinel, not a 1970 stamp. Deleting on it would make an
		// unreadable clock look like the oldest file on the device.
		val id = BlobStore.blobIdFor("keepme".toByteArray())
		store.write(id, 0, "keepme".toByteArray(), true)
		store.path(id)!!.setLastModified(0L)

		assertEquals(0L, store.pruneStale(maxAgeMs = 1, now = System.currentTimeMillis() + 10_000))
		assertNotNull(store.path(id))
	}

	@Test
	fun pruneStaleSurvivesARootThatWasNeverWritten() {
		val fresh = BlobStore(File(root, "never-written"))
		assertEquals(0L, fresh.pruneStale(maxAgeMs = 0))
	}

	@Test
	fun ingestingTheSameBytesTwiceDedupsToOneBlob() {
		val src = File(root, "source.bin").apply { writeText("the same bytes") }
		val first = store.ingestFile(src)
		assertEquals(first, store.ingestFile(src))
		assertEquals("the same bytes", store.path(first)!!.readText())
	}

	@Test
	fun refusesAnythingThatIsNotABlobId() {
		for (bad in listOf("", "sha256-xyz", "../escape", "sha256-" + "F".repeat(64))) {
			try {
				store.stat(bad)
				throw AssertionError("expected refusal for \"$bad\"")
			} catch (e: IllegalArgumentException) {
				assertTrue(e.message!!.contains("not a blob id"))
			}
		}
	}
}
