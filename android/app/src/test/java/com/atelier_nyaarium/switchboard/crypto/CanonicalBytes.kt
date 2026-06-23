package com.atelier_nyaarium.switchboard.crypto

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import java.util.Base64

/**
 * Asserts a signing-bytes preimage reproduces a cross-runtime vector's canonical
 * encodings (utf8 / hex / base64). The vector pins all three so the Kotlin twin is
 * held byte-exact against node:crypto; folding the per-encoding assertions into one
 * call keeps the per-op suites free of the repeated triple. Mirrors the TS
 * assertCanonicalBytes helper.
 */
object CanonicalBytes {
	/** `vec` is a vector entry (its `value`/`signature` siblings are ignored here);
	 * this checks `bytes` against its `signingBytes` / `signingBytesHex` /
	 * `signingBytesBase64` fields. */
	fun assertCanonicalBytes(bytes: ByteArray, vec: JsonObject) {
		assertEquals(vec["signingBytes"]!!.jsonPrimitive.content, bytes.toString(Charsets.UTF_8))
		assertEquals(vec["signingBytesHex"]!!.jsonPrimitive.content, bytes.joinToString("") { "%02x".format(it) })
		assertEquals(vec["signingBytesBase64"]!!.jsonPrimitive.content, Base64.getEncoder().encodeToString(bytes))
	}
}
