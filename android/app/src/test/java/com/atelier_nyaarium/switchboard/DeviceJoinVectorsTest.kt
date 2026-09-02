package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceJoinVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	@Test
	fun verifiesTheJoinVectorAndRejectsAChangedBoxKey() {
		val vector = json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("device-join/vectors.json")!!.bufferedReader().readText(),
		).jsonObject
		val approvalId = vector["approvalId"]!!.jsonPrimitive.content
		val nonce = vector["nonce"]!!.jsonPrimitive.content
		val newSignPub = vector["newSignPub"]!!.jsonPrimitive.content
		val newBoxPub = vector["newBoxPub"]!!.jsonPrimitive.content
		val signature = vector["signature"]!!.jsonPrimitive.content

		assertTrue(
			Crypto.verify(Crypto.deviceJoinSigningBytes(approvalId, nonce, newSignPub, newBoxPub), signature, newSignPub),
		)
		assertFalse(
			Crypto.verify(
				Crypto.deviceJoinSigningBytes(approvalId, nonce, newSignPub, newBoxPub.dropLast(1) + "A"),
				signature,
				newSignPub,
			),
		)
	}
}
