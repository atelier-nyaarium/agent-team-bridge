package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.NoticeId
import com.atelier_nyaarium.switchboard.proto.SessionId
import com.atelier_nyaarium.switchboard.proto.TeamAddress
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Drives the hand-authored SessionId/TeamAddress/NoticeId twin through the same
 * vectors the vitest suite reads (tests/fixtures/session-id/vectors.json), so the
 * twin cannot drift from the TS source: a differing canonical string fails here.
 */
class SessionIdVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("session-id/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	@Test
	fun teamAddressVectors() {
		for (v in vectors()["teamAddress"]!!.jsonArray) {
			val o = v.jsonObject
			val input = o["input"]!!.jsonPrimitive.content
			val localGatewayId = o["localGatewayId"]!!.jsonPrimitive.content
			val a = TeamAddress.parse(input, localGatewayId)
			assertEquals(input, o["gatewayId"]!!.jsonPrimitive.content, a.gatewayId)
			assertEquals(input, o["name"]!!.jsonPrimitive.content, a.name)
			assertEquals(input, o["canonical"]!!.jsonPrimitive.content, a.canonical)
			assertEquals(input, o["canonical"]!!.jsonPrimitive.content, TeamAddress.local(localGatewayId, input).canonical)
		}
	}

	@Test
	fun sessionIdVectors() {
		for (v in vectors()["sessionId"]!!.jsonArray) {
			val o = v.jsonObject
			val input = o["input"]!!.jsonPrimitive.content
			val localGatewayId = o["localGatewayId"]!!.jsonPrimitive.content
			val s = SessionId.parse(input, localGatewayId)
			assertNotNull(input, s)
			assertEquals(input, o["conversationId"]!!.jsonPrimitive.content, s!!.conversationId)
			assertEquals(input, o["targetCanonical"]!!.jsonPrimitive.content, s.target.canonical)
			assertEquals(input, o["key"]!!.jsonPrimitive.content, s.key)
			assertEquals(input, o["key"]!!.jsonPrimitive.content, SessionId.channel(s.conversationId, s.target).key)
		}
	}

	@Test
	fun noticeVectors() {
		for (v in vectors()["notice"]!!.jsonArray) {
			val o = v.jsonObject
			val input = o["input"]!!.jsonPrimitive.content
			val localGatewayId = o["localGatewayId"]!!.jsonPrimitive.content
			val n = NoticeId.parse(input, localGatewayId)
			assertNotNull(input, n)
			assertEquals(input, o["senderCanonical"]!!.jsonPrimitive.content, n!!.sender.canonical)
			assertEquals(input, o["key"]!!.jsonPrimitive.content, n.key)
		}
	}

	@Test
	fun rejectsNonSessionAndNonNotice() {
		for (s in vectors()["notSession"]!!.jsonArray) {
			val str = s.jsonPrimitive.content
			assertNull(str, SessionId.parse(str, "anyhost"))
		}
		for (s in vectors()["notNotice"]!!.jsonArray) {
			val str = s.jsonPrimitive.content
			assertNull(str, NoticeId.parse(str, "anyhost"))
		}
	}

	@Test
	fun crossHostKeyIsByteStable() {
		val wire = "conv:c:hostb/api"
		for (localGatewayId in listOf("hosta", "hostb", "whatever")) {
			assertEquals(wire, SessionId.parse(wire, localGatewayId)!!.key)
		}
	}

	@Test
	fun equalsAndHashCodeContract() {
		// These become HashMap keys; equal values must hash equal regardless of how
		// they were built (remote vs parsed-qualified).
		val a = TeamAddress.remote("hostb", "api")
		val b = TeamAddress.parse("hostb/api", "hosta")
		assertEquals(a, b)
		assertEquals(a.hashCode().toLong(), b.hashCode().toLong())
		val s1 = SessionId.channel("c", a)
		val s2 = SessionId.parse("conv:c:hostb/api", "whatever")!!
		assertEquals(s1, s2)
		assertEquals(s1.hashCode().toLong(), s2.hashCode().toLong())
	}
}
