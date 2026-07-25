package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Matcher
import com.atelier_nyaarium.switchboard.proto.Ref
import com.atelier_nyaarium.switchboard.proto.RefParseResult
import com.atelier_nyaarium.switchboard.proto.canonicalKey
import com.atelier_nyaarium.switchboard.proto.canonicalizeRefUri
import com.atelier_nyaarium.switchboard.proto.tryParseRef
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Drives the hand-authored ref grammar twin through the same vectors vitest reads
 * (tests/fixtures/refs/vectors.json), so it cannot drift from the TS source.
 *
 * The stake is specific: the MCP writes canonical keys into a message's manifest and this side
 * recomputes a key from a tapped link. One character of disagreement makes every tap on that ref
 * miss, with nothing to report why. Rejection is pinned too, code and offset, because a twin that
 * accepts what the other refuses is just as divergent.
 */
class RefGrammarVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun corpus() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("refs/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun expectedRef(o: kotlinx.serialization.json.JsonObject): Ref {
		val matcher = o["matcher"]
		return Ref(
			path = o["path"]!!.jsonPrimitive.content,
			segments = o["segments"]!!.jsonArray.map { it.jsonPrimitive.content },
			matcher = if (matcher == null || matcher is JsonNull) {
				null
			} else {
				val m = matcher.jsonObject
				val text = { key: String -> m[key]!!.jsonPrimitive.content }
				when (val kind = text("kind")) {
					"text" -> Matcher.Text(text("text"))
					"before" -> Matcher.Before(text("text"), text("anchor"))
					"after" -> Matcher.After(text("text"), text("anchor"))
					"range" -> Matcher.Range(text("from"), text("to"))
					else -> throw IllegalArgumentException("unknown matcher kind $kind")
				}
			},
		)
	}

	@Test
	fun everyVectorParsesToItsDeclaredStructure() {
		for (v in corpus()["vectors"]!!.jsonArray) {
			val o = v.jsonObject
			val id = o["id"]!!.jsonPrimitive.content
			val result = tryParseRef(o["uri"]!!.jsonPrimitive.content)

			assertEquals("$id did not parse", RefParseResult.Ok::class.java, result.javaClass)
			assertEquals(id, expectedRef(o["parsed"]!!.jsonObject), (result as RefParseResult.Ok).ref)
		}
	}

	@Test
	fun everyVectorCanonicalizesToItsDeclaredKey() {
		for (v in corpus()["vectors"]!!.jsonArray) {
			val o = v.jsonObject
			val id = o["id"]!!.jsonPrimitive.content

			assertEquals(id, o["canonical"]!!.jsonPrimitive.content, canonicalizeRefUri(o["uri"]!!.jsonPrimitive.content))
		}
	}

	@Test
	fun refsThatMeanDifferentThingsKeepDifferentKeys() {
		val vectors = corpus()["vectors"]!!.jsonArray.map { it.jsonObject }
		val byId = vectors.associateBy { it["id"]!!.jsonPrimitive.content }

		for (o in vectors) {
			val other = o["distinctFrom"]?.jsonPrimitive?.content ?: continue
			val id = o["id"]!!.jsonPrimitive.content
			val peer = byId[other] ?: throw IllegalStateException("$id names a distinctFrom that does not exist")

			assertNotEquals(
				"$id and $other collided",
				peer["canonical"]!!.jsonPrimitive.content,
				o["canonical"]!!.jsonPrimitive.content,
			)
		}
	}

	@Test
	fun everyErrorVectorIsRefusedWithItsDeclaredCodeAndOffset() {
		for (v in corpus()["errors"]!!.jsonArray) {
			val o = v.jsonObject
			val id = o["id"]!!.jsonPrimitive.content
			val result = tryParseRef(o["uri"]!!.jsonPrimitive.content)

			assertEquals("$id was not refused", RefParseResult.Error::class.java, result.javaClass)
			val error = result as RefParseResult.Error
			assertEquals("$id code", o["code"]!!.jsonPrimitive.content, error.code)
			assertEquals("$id offset", o["offset"]!!.jsonPrimitive.content.toInt(), error.offset)
		}
	}

	@Test
	fun somethingThatIsNotARefIsSaidToBeNeitherValidNorBroken() {
		for (v in corpus()["notRefs"]!!.jsonArray) {
			val uri = v.jsonPrimitive.content

			assertEquals(uri, RefParseResult.NotARef, tryParseRef(uri))
			assertNull(uri, canonicalizeRefUri(uri))
		}
	}

	@Test
	fun aKeyRecomputedFromAKeyIsStillTheSameKey() {
		// Idempotency is what lets the console canonicalize a tapped href that markdown-it already
		// normalized, and still land on the key the MCP wrote.
		for (v in corpus()["vectors"]!!.jsonArray) {
			val id = v.jsonObject["id"]!!.jsonPrimitive.content
			val once = canonicalizeRefUri(v.jsonObject["uri"]!!.jsonPrimitive.content)!!

			assertEquals("$id is not idempotent", once, canonicalizeRefUri(once))
		}
	}

	@Test
	fun theTwinNeverThrowsWhateverItIsHanded() {
		val alphabet = listOf("%", "3", "A", ":", "#", ".", "@", "<", ">", " ", "a", "/")
		var level = listOf("")
		repeat(3) {
			val next = ArrayList<String>()
			for (prefix in level) {
				for (c in alphabet) {
					val body = prefix + c
					tryParseRef("ref://$body")
					tryParseRef(body)
					(tryParseRef("ref://$body") as? RefParseResult.Ok)?.let { canonicalKey(it.ref) }
					next.add(body)
				}
			}
			level = next
		}
	}
}
