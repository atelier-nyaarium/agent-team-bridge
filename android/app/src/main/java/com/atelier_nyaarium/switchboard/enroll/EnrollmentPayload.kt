package com.atelier_nyaarium.switchboard.enroll

import com.atelier_nyaarium.switchboard.crypto.Crypto
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The scanned QR payload, the decode-side counterpart of switchboard's
 * EnrollmentPayloadSchema. Hand-parsed (not codegen'd) on purpose: a decode-side
 * union stays forward-compatible, so an unknown `type` returns null rather than
 * throwing. The SAS is the signing-key fingerprint the human confirms out-of-band
 * (the evie terminal / the arbiter console) before trusting the scan.
 */
sealed class EnrollmentPayload {
	data class EnrollOwner(
		val domainId: String,
		val evieAddr: String,
		val evieSignPub: String,
		val evieBoxPub: String,
		val nonce: String,
	) : EnrollmentPayload()

	data class AdmitHost(val hostId: String, val signPub: String, val boxPub: String) : EnrollmentPayload()

	data class AuthorizePhone(val domainId: String, val signPub: String, val boxPub: String) : EnrollmentPayload()

	/** The short authentication string: the fingerprint of the key being trusted. */
	fun sas(): String =
		when (this) {
			is EnrollOwner -> Crypto.fingerprint(evieSignPub)
			is AdmitHost -> Crypto.fingerprint(signPub)
			is AuthorizePhone -> Crypto.fingerprint(signPub)
		}
}

/** Parse a scanned QR string into a typed payload, or null when it is not a
 * recognized enrollment payload (unknown type / missing field / not JSON). */
fun parseEnrollmentPayload(raw: String): EnrollmentPayload? {
	val obj = runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return null
	return when (field(obj, "type")) {
		"enroll-owner" -> {
			val domainId = field(obj, "domainId")
			val evieAddr = field(obj, "evieAddr")
			val evieSignPub = b64Field(obj, "evieSignPub")
			val evieBoxPub = b64Field(obj, "evieBoxPub")
			val nonce = field(obj, "nonce")
			if (domainId == null || evieAddr == null || evieSignPub == null || evieBoxPub == null || nonce == null) {
				null
			} else {
				EnrollmentPayload.EnrollOwner(domainId, evieAddr, evieSignPub, evieBoxPub, nonce)
			}
		}
		"admit-host" -> {
			val hostId = field(obj, "hostId")
			val signPub = b64Field(obj, "signPub")
			val boxPub = b64Field(obj, "boxPub")
			if (hostId == null || signPub == null || boxPub == null) null
			else EnrollmentPayload.AdmitHost(hostId, signPub, boxPub)
		}
		"authorize-phone" -> {
			val domainId = field(obj, "domainId")
			val signPub = b64Field(obj, "signPub")
			val boxPub = b64Field(obj, "boxPub")
			if (domainId == null || signPub == null || boxPub == null) null
			else EnrollmentPayload.AuthorizePhone(domainId, signPub, boxPub)
		}
		else -> null
	}
}

private fun field(obj: JsonObject, key: String): String? = obj[key]?.jsonPrimitive?.contentOrNull

/** A string field that MUST decode as base64 (a key the SAS will fingerprint /
 * the admission will sign over). Returns null for a non-base64 value, so a hostile
 * QR is rejected as "not an enrollment code" rather than crashing the fingerprint
 * or producing an admission no one can verify. */
private fun b64Field(obj: JsonObject, key: String): String? =
	field(obj, key)?.takeIf { runCatching { Base64.getDecoder().decode(it) }.isSuccess }
