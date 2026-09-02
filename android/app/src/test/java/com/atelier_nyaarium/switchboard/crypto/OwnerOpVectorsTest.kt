package com.atelier_nyaarium.switchboard.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnerOpVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	@Test
	fun ownerOpSigningBytesMatchNode() {
		val root = json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("owner-op/vectors.json")!!.bufferedReader().readText(),
		).jsonObject
		val vector = root["ownerOp"]!!.jsonObject
		val value = vector["value"]!!.jsonObject
		assertEquals("{\"body\":\"y\",\"kind\":\"send\",\"to\":\"x\"}", canonicalJson(value["op"]!!.jsonObject))
		val bytes = ownerOpSigningBytes(
			value["domainId"]!!.jsonPrimitive.content,
			value["signerSignPub"]!!.jsonPrimitive.content,
			value["conversationId"]!!.jsonPrimitive.content,
			value["device"]!!.jsonPrimitive.content,
			value["opId"]!!.jsonPrimitive.content,
			value["at"]!!.jsonPrimitive.long,
			value["nonce"]!!.jsonPrimitive.content,
			value["op"]!!.jsonObject,
		)
		CanonicalBytes.assertCanonicalBytes(bytes, vector)
		assertTrue(
			Crypto.verify(
				bytes,
				vector["signature"]!!.jsonPrimitive.content,
				root["signerSignPub"]!!.jsonPrimitive.content,
			),
		)
	}
}
