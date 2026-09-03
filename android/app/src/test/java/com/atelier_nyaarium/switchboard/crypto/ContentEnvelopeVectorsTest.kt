package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.KeyEnvelope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.Base64
import com.atelier_nyaarium.switchboard.board.scheduledBodyAadKind

class ContentEnvelopeVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors(): JsonObject =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("content-envelope/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun bytes(value: String): ByteArray = Base64.getDecoder().decode(value)

	@Test
	fun derivationAndContentEnvelopesMatchNode() {
		val root = vectors()
		for (entry in root["derivation"]!!.jsonArray) {
			val value = entry.jsonObject
			assertArrayEquals(
				bytes(value["keyB64"]!!.jsonPrimitive.content),
				Crypto.deriveContentKey(
					value["ownerSignPrivB64"]!!.jsonPrimitive.content,
					value["domainId"]!!.jsonPrimitive.content,
					value["epoch"]!!.jsonPrimitive.int,
				),
			)
		}
		for (entry in root["envelopes"]!!.jsonArray) {
			val value = entry.jsonObject
			val epoch = value["epoch"]!!.jsonPrimitive.int
			val aad = Crypto.ContentAad(
				value["domainId"]!!.jsonPrimitive.content,
				value["ownerSignPub"]!!.jsonPrimitive.content,
				epoch,
				value["kind"]!!.jsonPrimitive.content,
			)
			if (value["plaintextUtf8"]!!.jsonPrimitive.content == "fixture scheduled inbox.body") {
				assertEquals("inbox.body\nconversation\nscheduled-op", scheduledBodyAadKind("conversation", "scheduled-op"))
			}
			val envelope = ContentEnvelope(
				v = 1L,
				epoch = epoch.toLong(),
				nonce = value["nonceB64"]!!.jsonPrimitive.content,
				ciphertext = value["ciphertextB64"]!!.jsonPrimitive.content,
			)
			assertArrayEquals(
				value["plaintextUtf8"]!!.jsonPrimitive.content.toByteArray(),
				Crypto.openContent(envelope, bytes(value["keyB64"]!!.jsonPrimitive.content), aad),
			)
			assertEquals(
				value["ciphertextB64"]!!.jsonPrimitive.content,
				Crypto.sealContent(
					value["plaintextUtf8"]!!.jsonPrimitive.content.toByteArray(),
					bytes(value["keyB64"]!!.jsonPrimitive.content),
					aad,
					bytes(value["nonceB64"]!!.jsonPrimitive.content),
				).ciphertext,
			)
		}
	}

	@Test
	fun keyRequestAndReceiptSigningBytesMatchNode() {
		val root = vectors()
		val request = root["keyRequest"]!!.jsonObject
		val requestValue = request["value"]!!.jsonObject
		val requestBytes = Crypto.keyRequestSigningBytes(
			requestValue["domainId"]!!.jsonPrimitive.content,
			requestValue["requesterSignPub"]!!.jsonPrimitive.content,
			requestValue["epochs"]!!.jsonArray.map { it.jsonPrimitive.long },
			requestValue["at"]!!.jsonPrimitive.long,
			requestValue["nonce"]!!.jsonPrimitive.content,
		)
		CanonicalBytes.assertCanonicalBytes(requestBytes, request)
		org.junit.Assert.assertTrue(
			Crypto.verify(
				requestBytes,
				request["signature"]!!.jsonPrimitive.content,
				requestValue["requesterSignPub"]!!.jsonPrimitive.content,
			),
		)

		val receipt = root["keyReceipt"]!!.jsonObject
		val receiptValue = receipt["value"]!!.jsonObject
		val receiptBytes = Crypto.keyReceiptSigningBytes(
			receiptValue["domainId"]!!.jsonPrimitive.content,
			receiptValue["recipientSignPub"]!!.jsonPrimitive.content,
			receiptValue["epoch"]!!.jsonPrimitive.long,
			receiptValue["at"]!!.jsonPrimitive.long,
			receiptValue["nonce"]!!.jsonPrimitive.content,
		)
		CanonicalBytes.assertCanonicalBytes(receiptBytes, receipt)
		org.junit.Assert.assertTrue(
			Crypto.verify(
				receiptBytes,
				receipt["signature"]!!.jsonPrimitive.content,
				receiptValue["recipientSignPub"]!!.jsonPrimitive.content,
			),
		)
	}

	@Test
	fun keyEnvelopeUnwrapsAndAadKindBindsCiphertext() {
		val root = vectors()
		val value = root["keyEnvelope"]!!.jsonObject
		val recipient = value["recipientBox"]!!.jsonObject
		val wire = value["envelope"]!!.jsonObject
		val sealed = wire["sealed"]!!.jsonObject
		val env = KeyEnvelope(
			wire["epoch"]!!.jsonPrimitive.long,
			wire["signerSignPub"]!!.jsonPrimitive.content,
			com.atelier_nyaarium.switchboard.proto.SealedEnvelope(
				sealed["ephemeralPub"]!!.jsonPrimitive.content,
				sealed["nonce"]!!.jsonPrimitive.content,
				sealed["ciphertext"]!!.jsonPrimitive.content,
				sealed["signature"]!!.jsonPrimitive.content,
			),
		)
		val unwrapped = Crypto.unwrapContentKey(
			env,
			recipient["priv"]!!.jsonPrimitive.content,
		)
		assertEquals(value["epoch"]!!.jsonPrimitive.int, unwrapped.first)
		assertArrayEquals(bytes(value["keyB64"]!!.jsonPrimitive.content), unwrapped.second)
		val relabeled = value["relabeledEpoch"]!!.jsonObject
		val relabeledSealed = relabeled["sealed"]!!.jsonObject
		assertThrows(Exception::class.java) {
			Crypto.unwrapContentKey(
				KeyEnvelope(
					relabeled["epoch"]!!.jsonPrimitive.long,
					relabeled["signerSignPub"]!!.jsonPrimitive.content,
					com.atelier_nyaarium.switchboard.proto.SealedEnvelope(
						relabeledSealed["ephemeralPub"]!!.jsonPrimitive.content,
						relabeledSealed["nonce"]!!.jsonPrimitive.content,
						relabeledSealed["ciphertext"]!!.jsonPrimitive.content,
						relabeledSealed["signature"]!!.jsonPrimitive.content,
					),
				),
				recipient["priv"]!!.jsonPrimitive.content,
			)
		}
		assertThrows(Exception::class.java) {
			Crypto.unwrapContentKey(env.copy(epoch = 0L), recipient["priv"]!!.jsonPrimitive.content)
		}
		assertThrows(Exception::class.java) {
			Crypto.unwrapContentKey(env.copy(epoch = 2_147_483_648L), recipient["priv"]!!.jsonPrimitive.content)
		}

		val content = root["envelopes"]!!.jsonArray[0].jsonObject
		val domainId = content["domainId"]!!.jsonPrimitive.content
		val epoch = content["epoch"]!!.jsonPrimitive.int
		val aad = Crypto.ContentAad(domainId, content["ownerSignPub"]!!.jsonPrimitive.content, epoch, "wrong.kind")
		val contentEnv = ContentEnvelope(
			v = 1L,
			epoch = epoch.toLong(),
			nonce = content["nonceB64"]!!.jsonPrimitive.content,
			ciphertext = content["ciphertextB64"]!!.jsonPrimitive.content,
		)
		assertThrows(Exception::class.java) {
			Crypto.openContent(contentEnv, bytes(content["keyB64"]!!.jsonPrimitive.content), aad)
		}
		val validAad = Crypto.ContentAad(
			domainId,
			content["ownerSignPub"]!!.jsonPrimitive.content,
			epoch,
			content["kind"]!!.jsonPrimitive.content,
		)
		assertThrows(Exception::class.java) {
			Crypto.openContent(
				contentEnv.copy(epoch = contentEnv.epoch + 1L),
				bytes(content["keyB64"]!!.jsonPrimitive.content),
				validAad,
			)
		}
		assertThrows(Exception::class.java) {
			Crypto.openContent(
				contentEnv,
				bytes(content["keyB64"]!!.jsonPrimitive.content),
				validAad.copy(domainId = "changed"),
			)
		}
		assertArrayEquals(
			content["plaintextUtf8"]!!.jsonPrimitive.content.toByteArray(),
			Crypto.openContent(
				contentEnv.copy(ciphertext = root["acceptedCiphertextB64"]!!.jsonPrimitive.content),
				bytes(content["keyB64"]!!.jsonPrimitive.content),
				validAad,
			),
		)
		assertThrows(Exception::class.java) {
			Crypto.openContent(
				contentEnv.copy(ciphertext = root["refusedCiphertext"]!!.jsonPrimitive.content),
				bytes(content["keyB64"]!!.jsonPrimitive.content),
				validAad,
			)
		}
		val ciphertext = bytes(content["ciphertextB64"]!!.jsonPrimitive.content).also {
			it[0] = (it[0].toInt() xor 1).toByte()
		}
		assertThrows(Exception::class.java) {
			Crypto.openContent(
				contentEnv.copy(ciphertext = Base64.getEncoder().encodeToString(ciphertext)),
				bytes(content["keyB64"]!!.jsonPrimitive.content),
				validAad,
			)
		}
		assertThrows(Exception::class.java) {
			Crypto.openContent(contentEnv.copy(v = 2L), bytes(content["keyB64"]!!.jsonPrimitive.content), validAad)
		}
		assertThrows(Exception::class.java) {
			Crypto.openContent(
				contentEnv.copy(ciphertext = Base64.getEncoder().encodeToString(ByteArray(15))),
				bytes(content["keyB64"]!!.jsonPrimitive.content),
				validAad,
			)
		}
		for (nonce in root["refusedNonces"]!!.jsonArray.map { it.jsonPrimitive.content }) {
			assertThrows(Exception::class.java) {
				Crypto.openContent(contentEnv.copy(nonce = nonce), bytes(content["keyB64"]!!.jsonPrimitive.content), validAad)
			}
		}
	}

	@Test
	fun contentCryptoRefusesWrongKeyAndNonceLengths() {
		val identity = Crypto.generateIdentity()
		val aad = Crypto.ContentAad("alice", identity.sign.pub, 1, "board.title")
		val key = ByteArray(32)
		assertThrows(IllegalArgumentException::class.java) {
			Crypto.sealContent("text".toByteArray(), ByteArray(31), aad, ByteArray(12))
		}
		assertThrows(IllegalArgumentException::class.java) {
			Crypto.sealContent("text".toByteArray(), key, aad, ByteArray(11))
		}
		assertThrows(IllegalArgumentException::class.java) {
			Crypto.openContent(ContentEnvelope(v = 1L, epoch = 1L, nonce = "AA==", ciphertext = "AA=="), ByteArray(31), aad)
		}
		assertThrows(IllegalArgumentException::class.java) {
			Crypto.openContent(
				ContentEnvelope(v = 1L, epoch = 1L, nonce = Base64.getEncoder().encodeToString(ByteArray(11)), ciphertext = "AA=="),
				key,
				aad,
			)
		}
		assertThrows(IllegalArgumentException::class.java) {
			Crypto.deriveContentKey(Base64.getEncoder().encodeToString(ByteArray(31)), "alice", 1)
		}
		assertThrows(IllegalArgumentException::class.java) {
			Crypto.wrapContentKey(ByteArray(31), 1, identity.box.pub, identity.sign.pub, identity.sign.priv)
		}
		assertThrows(IllegalArgumentException::class.java) {
			Crypto.wrapContentKey(ByteArray(32), 0, identity.box.pub, identity.sign.pub, identity.sign.priv)
		}
		assertThrows(IllegalArgumentException::class.java) {
			Crypto.deriveContentKey(identity.sign.priv, "alice", 0)
		}
	}
}
