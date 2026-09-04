package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Protocol
import java.security.MessageDigest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

fun canonicalJson(element: JsonElement): String = when (element) {
	is JsonObject -> element.keys.sorted().joinToString(separator = ",", prefix = "{", postfix = "}") { key ->
		"${JsonPrimitive(key)}:${canonicalJson(element.getValue(key))}"
	}
	is kotlinx.serialization.json.JsonArray -> element.joinToString(
		separator = ",",
		prefix = "[",
		postfix = "]",
		transform = ::canonicalJson,
	)
	else -> element.toString()
}

fun sha256Hex(text: String): String = MessageDigest.getInstance("SHA-256")
	.digest(text.toByteArray(Charsets.UTF_8))
	.joinToString("") { "%02x".format(it) }

fun ownerOpSigningBytes(
	domainId: String,
	signerSignPub: String,
	conversationId: String,
	device: String,
	opId: String,
	at: Long,
	nonce: String,
	opJson: JsonObject,
): ByteArray = listOf(
	Protocol.Wire.SIGNING_TAG_OWNER_OP,
	domainId,
	signerSignPub,
	conversationId,
	device,
	opId,
	at.toString(),
	nonce,
	sha256Hex(canonicalJson(opJson)),
).joinToString("\n").toByteArray(Charsets.UTF_8)
