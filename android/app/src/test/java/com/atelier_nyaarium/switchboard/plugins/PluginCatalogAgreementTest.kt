package com.atelier_nyaarium.switchboard.plugins

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The compile-time replacement for nyaadot's filesystem discovery scan: the
 * "manifest marks the package" invariant is enforced HERE instead of at runtime. The catalog and
 * the `assets/plugins/<dir>/manifest.json` folders must agree exactly, and each folder is named
 * by its manifest's content_id - so a plugin folder cannot ship unregistered, a catalog entry
 * cannot point at nothing, and an id can never drift from its folder.
 *
 * `src/main/assets` is on the test classpath (see app/build.gradle.kts sourceSets).
 */
class PluginCatalogAgreementTest {

	private fun assetPluginDirs(): List<String> {
		val url = javaClass.classLoader!!.getResource("plugins") ?: return emptyList()
		val dir = File(url.toURI())
		if (!dir.isDirectory) return emptyList()
		return dir.listFiles { f: File -> f.isDirectory }?.map { it.name }?.sorted() ?: emptyList()
	}

	private fun manifestText(assetDir: String): String =
		javaClass.classLoader!!.getResourceAsStream("plugins/$assetDir/manifest.json")!!
			.bufferedReader().readText()

	@Test
	fun catalogAndAssetFoldersAgreeExactly() {
		assertEquals(assetPluginDirs(), PluginCatalog.all.map { it.assetDir }.sorted())
	}

	@Test
	fun everyBakedManifestParsesAndItsFolderIsItsContentId() {
		PluginCatalog.all.forEach { entry ->
			val manifest = PluginManifest.parse(manifestText(entry.assetDir))
			assertEquals(
				"folder assets/plugins/${entry.assetDir} must be named by its manifest content_id",
				entry.assetDir,
				manifest.contentId,
			)
		}
	}

	@Test
	fun catalogHasNoDuplicateEntries() {
		val dirs = PluginCatalog.all.map { it.assetDir }
		assertEquals(dirs.distinct(), dirs)
	}
}
