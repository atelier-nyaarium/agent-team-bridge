package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.KeyEnvelope
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Base64

class ContentKeyringMergeVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun fixture(): JsonObject = json.parseToJsonElement(
		javaClass.classLoader!!.getResourceAsStream("content-envelope/keyring-merge.json")!!.bufferedReader().readText(),
	).jsonObject

	private fun text(value: JsonObject, name: String): String = value[name]!!.jsonPrimitive.content

	private fun bytes(value: String): ByteArray = Base64.getDecoder().decode(value)

	/** The fixture names the gateway's reason code; the phone says it in prose. */
	private fun refusalOf(code: String): String = when (code) {
		"different_key" -> "content key conflicts with the held epoch"
		"untrusted_signer" -> "key signer is not an admitted console"
		else -> error("unknown refusal code $code")
	}

	private fun envelope(value: JsonObject): KeyEnvelope = KeyEnvelope(
		epoch = value["epoch"]!!.jsonPrimitive.long,
		signerSignPub = text(value, "signerSignPub"),
		sealed = value["sealed"]!!.jsonObject.let {
			SealedEnvelope(text(it, "ephemeralPub"), text(it, "nonce"), text(it, "ciphertext"), text(it, "signature"))
		},
	)

	@Test
	fun allMergeCasesMatch() {
		val root = fixture()
		val recipient = root["recipientBox"]!!.jsonObject
		val admitted = root["admittedSigner"]!!.jsonObject
		val owner = Crypto.generateIdentity()
		val admission = AdmissionCrypto.signAdmission(
			Admission("console", text(admitted, "pub"), "fixture-box", null, 1, "fixture-admission"),
			owner.sign.priv,
			owner.sign.pub,
		)
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admission), emptyList()))
		val envelopeMap = root["envelopes"]!!.jsonObject

		for (case in root["cases"]!!.jsonArray) {
			val entry = case.jsonObject
			val contentKeyring = ContentKeyring(text(recipient, "priv"))
			val held = bytes(text(root["held"]!!.jsonObject, "1"))
			contentKeyring.commit(ContentKeyring.Merge.Installed(mapOf(1 to held), listOf(1)))
			val envelopes = entry["envelopes"]!!.jsonArray.map { envelope(envelopeMap[it.jsonPrimitive.content]!!.jsonObject) }
			val merge = contentKeyring.classify(envelopes, keyring)

			when (text(entry, "decision")) {
				"refused" -> assertEquals(refusalOf(text(entry, "reason")), (merge as ContentKeyring.Merge.Refused).reason)
				"unchanged" -> assertEquals(ContentKeyring.Merge.Unchanged, merge)
				"installed" -> {
					val installed = merge as ContentKeyring.Merge.Installed
					contentKeyring.commit(installed)
				}
			}
			assertEquals(
				entry["expectedEpochs"]!!.jsonArray.map { it.jsonPrimitive.int },
				contentKeyring.epochs(),
			)
		}
	}
}
