package com.atelier_nyaarium.switchboard.plugins.references

import com.atelier_nyaarium.switchboard.MessageFile
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * The manifest selection rule and the miss contract.
 *
 * A tapped ref resolves against the tapped row's OWN manifest, so these are the paths that decide
 * whether a tap opens code, opens the wrong code, or falls back to the link menu. Falling back is
 * always acceptable; opening the wrong code never is.
 */
class RefManifestTest {
	private lateinit var filesDir: File

	@Before
	fun setUp() {
		filesDir = File.createTempFile("ref-manifest", "").let {
			it.delete()
			it.mkdirs()
			it
		}
	}

	@After
	fun tearDown() {
		filesDir.deleteRecursively()
	}

	/** Write a file into the attachments tree the way a drained message would, returning its src. */
	private fun attach(bucket: String, name: String, body: String): MessageFile {
		val dir = File(filesDir, "attachments/$bucket")
		dir.mkdirs()
		File(dir, name).writeText(body)
		return MessageFile(name, "text/plain", "attachments/$bucket/$name")
	}

	private fun manifestJson(filename: String = "cart.ts", refPath: String = "src/cart.ts") = """
		{
		  "switchboardReferences": 1,
		  "files": [{ "refPath": "$refPath", "filename": "$filename", "mode": "full", "totalLines": 9 }],
		  "refs": {
		    "ref://$refPath:Cart:add": {
		      "refPath": "$refPath", "startLine": 2, "endLine": 4, "quality": "exact"
		    }
		  }
		}
	""".trimIndent()

	@Test
	fun readsTheManifestARowCarries() {
		val files = listOf(
			attach("b1", MANIFEST_FILENAME, manifestJson()),
			attach("b1", "cart.ts", "class Cart {}\n"),
		)

		val manifest = manifestFrom(filesDir, files)

		assertNotNull(manifest)
		assertEquals(1, manifest!!.files.size)
		assertEquals(2, manifest.refs["ref://src/cart.ts:Cart:add"]!!.startLine)
	}

	@Test
	fun aRowWithNoManifestResolvesToNothing() {
		val files = listOf(attach("b2", "notes.txt", "just an attachment\n"))

		assertNull(manifestFrom(filesDir, files))
	}

	@Test
	fun aFileBearingTheMarkerButNotTheReservedNameIsNeverAdopted() {
		// A snapshot of a project file that happens to contain the marker text is an ordinary
		// attachment. Only the reserved name is ever consulted.
		val files = listOf(attach("b3", "impostor.json", manifestJson()))

		assertNull(manifestFrom(filesDir, files))
	}

	@Test
	fun aReservedNameCarryingNoMarkerIsRejected() {
		val files = listOf(attach("b4", MANIFEST_FILENAME, """{ "files": [], "refs": {} }"""))

		assertNull(manifestFrom(filesDir, files))
	}

	@Test
	fun unparseableJsonIsRejectedRatherThanThrowing() {
		val files = listOf(attach("b5", MANIFEST_FILENAME, "{ not json at all"))

		assertNull(manifestFrom(filesDir, files))
	}

	@Test
	fun aManifestNamingASnapshotThatIsNotOnThisRowIsRejectedWholesale() {
		// Partly trusting it would let a manifest point the viewer at a file from somewhere else.
		val files = listOf(attach("b6", MANIFEST_FILENAME, manifestJson(filename = "elsewhere.ts")))

		assertNull(manifestFrom(filesDir, files))
	}

	@Test
	fun theFirstReservedNameWinsSoALaterOneCannotDisplaceIt() {
		val first = attach("b7", MANIFEST_FILENAME, manifestJson(refPath = "src/real.ts", filename = "real.ts"))
		val snapshot = attach("b7", "real.ts", "real\n")
		val second = attach("b8", MANIFEST_FILENAME, manifestJson(refPath = "src/evil.ts", filename = "evil.ts"))
		attach("b8", "evil.ts", "evil\n")

		val manifest = manifestFrom(filesDir, listOf(first, snapshot, second))

		assertEquals("src/real.ts", manifest!!.files.single().refPath)
	}

	@Test
	fun aPurgedSnapshotLeavesTheManifestUnusable() {
		val files = listOf(
			attach("b9", MANIFEST_FILENAME, manifestJson()),
			attach("b9", "cart.ts", "class Cart {}\n"),
		)
		File(filesDir, "attachments/b9/cart.ts").delete()

		// The manifest still parses (the row still lists the file), but resolving the snapshot is what
		// the link handler checks before claiming, so the tap falls through to the menu.
		assertNotNull(manifestFrom(filesDir, files))
		assertNull(com.atelier_nyaarium.switchboard.Attachments.resolve(filesDir, "b9/cart.ts"))
	}
}

/** The banner text, which is the only thing telling a reader the code moved under the ref. */
class ReferenceNoticeTest {
	private fun entry(quality: String, reason: String? = null, ambiguous: Boolean = false, count: Int = 1) =
		RefEntry("src/a.ts", 1, 2, null, quality, reason, ambiguous, count)

	@Test
	fun anExactResolutionSaysNothing() {
		assertNull(noticeFor(entry("exact")))
	}

	@Test
	fun aFuzzyResolutionExplainsItself() {
		assertEquals("matched \"add\" by text", noticeFor(entry("fuzzy", "matched \"add\" by text")))
	}

	@Test
	fun anUnresolvedRefSaysSoEvenWithNoReason() {
		assertNotNull(noticeFor(entry("unresolved")))
	}

	@Test
	fun anAmbiguousMatchSaysHowManyAnswered() {
		val notice = noticeFor(entry("exact", ambiguous = true, count = 3))

		assertEquals("3 declarations matched; showing the first", notice)
	}

	@Test
	fun driftAndAmbiguityAreBothReported() {
		val notice = noticeFor(entry("fuzzy", "scope renamed", ambiguous = true, count = 2))!!

		assertEquals(true, notice.contains("scope renamed"))
		assertEquals(true, notice.contains("2 declarations"))
	}
}
