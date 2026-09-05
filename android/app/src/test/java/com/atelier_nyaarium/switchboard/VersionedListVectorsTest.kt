package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Drives the fold twin through the vectors src/__tests__/versioned-list.test.ts reads. */
class VersionedListVectorsTest {
	private data class Entry(val id: String, val revision: Long)

	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("versioned-list/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun entries(array: kotlinx.serialization.json.JsonElement) =
		array.jsonArray.map { Entry(it.jsonObject["id"]!!.jsonPrimitive.content, it.jsonObject["revision"]!!.jsonPrimitive.long) }

	@Test
	fun theFoldMatchesTheSharedRule() {
		for (case in vectors["cases"]!!.jsonArray) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val held = o["held"]!!.jsonObject
			val incoming = o["incoming"]!!.jsonObject
			val expected = o["expected"]!!.jsonObject
			val fold = foldVersionedList(
				held["revision"]!!.jsonPrimitive.long,
				entries(held["entries"]!!),
				VersionedList(
					incoming["revision"]!!.jsonPrimitive.long,
					incoming["since"]!!.jsonPrimitive.long,
					entries(incoming["entries"]!!),
				),
				{ it.id },
				{ it.revision },
			)
			when (expected["kind"]!!.jsonPrimitive.content) {
				"apply" -> {
					assertTrue(name, fold is VersionedFold.Apply)
					val apply = fold as VersionedFold.Apply
					assertEquals(name, expected["revision"]!!.jsonPrimitive.long, apply.revision)
					assertEquals(name, entries(expected["entries"]!!), apply.entries)
				}
				"restart" -> assertEquals(name, VersionedFold.Restart, fold)
				"ignore" -> assertEquals(name, VersionedFold.Ignore, fold)
				else -> error("unknown kind in $name")
			}
		}
	}
}
