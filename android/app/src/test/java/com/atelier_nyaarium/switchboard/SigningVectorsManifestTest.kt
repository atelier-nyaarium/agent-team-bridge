package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reads tests/fixtures/_signing-vectors-manifest.json (the same inventory the vitest
 * signing-vectors-manifest.test.ts reads) and forces every listed signing-vector
 * directory through Kotlin: each vectors.json must exist on the classpath and parse.
 * So a corpus registered in the manifest can never be read by TS alone - ci.yml does
 * not run these Android unit tests, so without this gate a future op's TS-only vector
 * would pass CI yet silently lack a Kotlin reader. The per-op suites (ProvisionOpsTest,
 * XDomainLinkTest, SasCryptoTest, SessionIdVectorsTest, SyncCursorVectorsTest) still own
 * the byte-level assertions; existence + parse is enough for the coverage guarantee here.
 */
class SigningVectorsManifestTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun resource(name: String): String =
		javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()

	@Test
	fun everyListedSigningVectorCorpusParsesOnAndroid() {
		val directories = json.parseToJsonElement(resource("_signing-vectors-manifest.json"))
			.jsonObject["directories"]!!.jsonArray
		assertTrue("manifest must list at least one directory", directories.isNotEmpty())
		for (entry in directories) {
			val dir = entry.jsonPrimitive.content
			val body = resource("$dir/vectors.json")
			// Parsing throws on malformed JSON, failing the gate for that corpus.
			val parsed = json.parseToJsonElement(body).jsonObject
			assertTrue("$dir/vectors.json must be a non-empty object", parsed.isNotEmpty())
		}
	}
}
