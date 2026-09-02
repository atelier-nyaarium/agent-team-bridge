package com.atelier_nyaarium.switchboard.crypto

import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Holds this Kotlin port and `src/shared/sealed-blob.ts` to one framing, through the shared corpus
 * at tests/fixtures/sealed-blob/vectors.json.
 *
 * The AAD binds the blob id, the chunk index and the final flag. A single character of difference
 * between the runtimes means nothing the Router holds can be opened, and a test written inside
 * either runtime alone cannot catch it, because both halves of such a test share the mistake.
 */
class SealedBlobVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	@Test
	fun opensEveryVectorTheTypeScriptSideSealed() {
		val root = json
			.parseToJsonElement(
				javaClass.classLoader!!.getResourceAsStream("sealed-blob/vectors.json")!!.bufferedReader().readText(),
			)
			.jsonObject
		val key = Base64.getDecoder().decode(root["key"]!!.jsonPrimitive.content)
		val ctx = root["context"]!!.jsonObject
		val context = BlobSealContext(
			domainId = ctx["domainId"]!!.jsonPrimitive.content,
			ownerSignPub = ctx["ownerSignPub"]!!.jsonPrimitive.content,
			epoch = ctx["epoch"]!!.jsonPrimitive.content.toInt(),
			blobId = ctx["blobId"]!!.jsonPrimitive.content,
		)

		// The AAD bytes themselves, so a divergence is named here rather than surfacing as a failed open.
		assertEquals(
			root["aadSample"]!!.jsonPrimitive.content,
			Base64.getEncoder().encodeToString(blobChunkAad(context, 0, true).bytes()),
		)

		for (case in root["cases"]!!.jsonArray) {
			val size = case.jsonObject["size"]!!.jsonPrimitive.content.toLong()
			assertEquals(
				case.jsonObject["ciphertextSize"]!!.jsonPrimitive.content.toLong(),
				sealedBlobSize(size),
			)
			val frames = case.jsonObject["frames"]!!.jsonArray
				.map { Base64.getDecoder().decode(it.jsonPrimitive.content) }
			val ciphertext = frames.reduce { a, b -> a + b }
			val opened = openSealedBlobRange(ciphertext, 0L, size, context.epoch, 0L, size, key, context.domainId, context.ownerSignPub, context.blobId)
			assertArrayEquals(ByteArray(size.toInt()) { 65 }, opened.first)
		}
	}
}
