package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Drives the hand-authored reach twin through the same vectors the vitest suite reads
 * (tests/fixtures/router-reach/vectors.json), so this file and src/shared/router-reach.ts cannot
 * drift. Both the phone and the Gateway order their Router addresses by this rule, and a rule that
 * changed on one side only shows up as an outage in exactly one physical location - the hardest
 * kind to see, since measuring it anywhere else says everything is fine.
 */
class RouterReachVectorsTest {

	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("router-reach/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private val routerPort = vectors["routerPort"]!!.jsonPrimitive.int

	@Test
	fun candidateOrderMatchesTheSharedRule() {
		for (case in vectors["candidates"]!!.jsonArray) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val r = o["reach"]!!.jsonObject
			val reach = RouterReach(
				publicHost = r["publicHost"]?.jsonPrimitive?.takeIf { !it.isString || it.content.isNotEmpty() }
					?.let { if (it.toString() == "null") null else it.content },
				publicPort = r["publicPort"]?.jsonPrimitive?.let { if (it.toString() == "null") null else it.int },
				lanAddresses = r["lanAddresses"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
			)
			val expected = o["expected"]!!.jsonArray.map { it.jsonPrimitive.content }
			assertEquals(name, expected, reachCandidates(reach, o["bootstrapUrl"]!!.jsonPrimitive.content, routerPort))
		}
	}

	@Test
	fun privateHostClassificationMatchesTheSharedRule() {
		for (case in vectors["privateHosts"]!!.jsonArray) {
			val o = case.jsonObject
			val host = o["host"]!!.jsonPrimitive.content
			assertEquals(host, o["private"]!!.jsonPrimitive.boolean, isPrivateHost(host))
		}
	}
}
