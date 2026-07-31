package com.atelier_nyaarium.switchboard.plugins.references

import com.atelier_nyaarium.switchboard.Message
import com.atelier_nyaarium.switchboard.MessageFile
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Pins the one-shot pre-role row conversion: roles by the old positional convention, ref metadata
 * rebuilt from the on-disk manifest, own rows exempt from the positional rule, and every re-run
 * converging (already-roled rows pass through). */
class LegacyRefMigrationTest {

	@get:Rule
	val tmp = TemporaryFolder()

	private val manifestJson = """
		{
			"switchboardReferences": 1,
			"files": [
				{"refPath": "src/cart.ts", "filename": "cart.ts", "mode": "snippet", "totalLines": 400,
				 "segments": [{"startLine": 97, "text": "a\nb\nc"}]}
			],
			"refs": {
				"ref://src/cart.ts:Cart:add": {"refPath": "src/cart.ts", "startLine": 100, "endLine": 110, "quality": "exact"}
			}
		}
	""".trimIndent()

	private fun file(name: String, src: String? = null, role: String? = null) =
		MessageFile(name, "text/plain", src, role = role)

	private fun landManifest(filesDir: File): String {
		val bucket = File(File(filesDir, "attachments"), "1-1").apply { mkdirs() }
		File(bucket, "switchboard-references.json").writeText(manifestJson)
		return "attachments/1-1/switchboard-references.json"
	}

	@Test
	fun anInboundRowStampsThePositionalConventionAndRebuildsRefMetadata() {
		val filesDir = tmp.newFolder()
		val src = landManifest(filesDir)
		val row = Message(
			false,
			"see the ref",
			100,
			files = listOf(file("shot.png"), file("switchboard-references.json", src = src), file("cart.ts")),
		)

		val migrated = LegacyRefMigration.migrate(listOf(row), filesDir).single()

		assertEquals(listOf("attachment", "ref-snapshot", "ref-snapshot"), migrated.files.map { it.role })
		val meta = migrated.files.single { it.name == "cart.ts" }.ref!!
		assertEquals("src/cart.ts", meta.refPath)
		assertEquals(97L, meta.segments!!.single().startLine)
		assertEquals(3L, meta.segments!!.single().lineCount)
		assertEquals("ref://src/cart.ts:Cart:add", meta.keys.single().key)
	}

	@Test
	fun anOwnRowNeverTakesThePositionalRule() {
		// A file the owner named like the old manifest is a genuine attachment; relabeling it would
		// hide the owner's own file.
		val filesDir = tmp.newFolder()
		val row = Message(
			true,
			"here are my files",
			100,
			files = listOf(file("switchboard-references.json"), file("notes.md")),
		)

		val migrated = LegacyRefMigration.migrate(listOf(row), filesDir).single()

		assertEquals(listOf("attachment", "attachment"), migrated.files.map { it.role })
	}

	@Test
	fun aRowWhoseManifestNeverLandedStillStampsRolesAndSkipsTheMetadata() {
		val filesDir = tmp.newFolder()
		val row = Message(
			false,
			"",
			100,
			files = listOf(file("switchboard-references.json"), file("cart.ts")),
		)

		val migrated = LegacyRefMigration.migrate(listOf(row), filesDir).single()

		assertEquals(listOf("ref-snapshot", "ref-snapshot"), migrated.files.map { it.role })
		assertNull(migrated.files[1].ref)
	}

	@Test
	fun anAlreadyConvertedRowPassesThroughUntouchedWhichIsWhatMakesARerunConverge() {
		val filesDir = tmp.newFolder()
		val row = Message(false, "", 100, files = listOf(file("shot.png", role = "attachment")))

		assertEquals(listOf(row), LegacyRefMigration.migrate(listOf(row), filesDir))
	}
}
