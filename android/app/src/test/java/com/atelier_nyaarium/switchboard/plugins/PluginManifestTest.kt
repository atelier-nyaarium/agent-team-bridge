package com.atelier_nyaarium.switchboard.plugins

import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PluginManifestTest {

	@Test
	fun parsesAFullManifest() {
		val m = PluginManifest.parse(
			"""
			{
				"author": "nyaarium",
				"content_id": "designer",
				"version": "1.2.0",
				"display_name": "Designer",
				"description": "Design previews in the thread.",
				"requires": [{ "content_id": "core-thing" }],
				"entry_point": ""
			}
			""",
		)
		assertEquals("nyaarium.designer", m.compositeId)
		assertEquals("1.2.0", m.version)
		assertEquals("Designer", m.displayName)
		assertEquals(listOf("core-thing"), m.requires.map { it.contentId })
	}

	@Test
	fun authorlessCompositeIdIsTheBareContentId() {
		val m = PluginManifest.parse("""{ "content_id": "designer" }""")
		assertEquals("designer", m.compositeId)
	}

	@Test
	fun missingContentIdRefuses() {
		assertThrows(SerializationException::class.java) {
			PluginManifest.parse("""{ "display_name": "No id" }""")
		}
	}

	@Test
	fun nonSlugContentIdRefuses() {
		assertThrows(IllegalArgumentException::class.java) {
			PluginManifest.parse("""{ "content_id": "Has.Dots" }""")
		}
	}

	@Test
	fun nonSlugAuthorRefuses() {
		assertThrows(IllegalArgumentException::class.java) {
			PluginManifest.parse("""{ "author": "Bad Author", "content_id": "ok" }""")
		}
	}

	@Test
	fun emptyRequiresEntryRefuses() {
		assertThrows(IllegalArgumentException::class.java) {
			PluginManifest.parse("""{ "content_id": "ok", "requires": [{ "content_id": "" }] }""")
		}
	}

	@Test
	fun unknownKeysAreIgnoredForForwardCompat() {
		val m = PluginManifest.parse("""{ "content_id": "ok", "future_field": { "nested": true } }""")
		assertTrue(m.compositeId == "ok")
	}
}
