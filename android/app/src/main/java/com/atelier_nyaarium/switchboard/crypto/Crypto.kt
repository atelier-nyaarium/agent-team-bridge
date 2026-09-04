package com.atelier_nyaarium.switchboard.crypto

import java.security.MessageDigest
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.Serializable
import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.engines.AESEngine
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.modes.GCMBlockCipher
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.KeyEnvelope
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope as ProtoSealedEnvelope

/** Byte-compatible federation crypto for the TypeScript implementation. */
object Crypto {
	data class ContentAad(val domainId: String, val ownerSignPub: String, val epoch: Int, val kind: String) {
		fun bytes(): ByteArray =
			"$CONTENT_INFO_PREFIX$domainId\n$ownerSignPub\n$epoch\n$kind".toByteArray(Charsets.UTF_8)
	}
	@Serializable
	data class KeyPairRaw(val pub: String, val priv: String)

	@Serializable
	data class Identity(val sign: KeyPairRaw, val box: KeyPairRaw)
	data class SealedEnvelope(
		val ephemeralPub: String,
		val nonce: String,
		val ciphertext: String,
		val signature: String,
	)

	private val HKDF_INFO = "switchboard-seal-v1".toByteArray(Charsets.UTF_8)
	private val CONTENT_SALT = "switchboard-content-salt-v1".toByteArray(Charsets.UTF_8)
	private val CONTENT_INFO_PREFIX = "switchboard-content-v1\n"
	private val rnd = SecureRandom()

	private fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
	private fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)

	fun generateIdentity(): Identity {
		val ed = Ed25519PrivateKeyParameters(rnd)
		val x = X25519PrivateKeyParameters(rnd)
		return Identity(
			sign = KeyPairRaw(b64(ed.generatePublicKey().encoded), b64(ed.encoded)),
			box = KeyPairRaw(b64(x.generatePublicKey().encoded), b64(x.encoded)),
		)
	}

	fun sign(data: ByteArray, signPrivB64: String): String {
		val signer = Ed25519Signer()
		signer.init(true, Ed25519PrivateKeyParameters(unb64(signPrivB64), 0))
		signer.update(data, 0, data.size)
		return b64(signer.generateSignature())
	}

	fun verify(data: ByteArray, signatureB64: String, signPubB64: String): Boolean =
		try {
			val verifier = Ed25519Signer()
			verifier.init(false, Ed25519PublicKeyParameters(unb64(signPubB64), 0))
			verifier.update(data, 0, data.size)
			verifier.verifySignature(unb64(signatureB64))
		} catch (_: Exception) {
			false
		}

	fun deviceJoinSigningBytes(approvalId: String, nonce: String, newSignPub: String, newBoxPub: String): ByteArray =
		listOf(Protocol.Wire.SIGNING_TAG_DEVICE_JOIN, approvalId, nonce, newSignPub, newBoxPub).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun keyRequestSigningBytes(
		domainId: String,
		requesterSignPub: String,
		epochs: List<Long>,
		at: Long,
		nonce: String,
	): ByteArray =
		listOf(Protocol.Wire.SIGNING_TAG_KEY_REQUEST, domainId, requesterSignPub, epochs.joinToString(","), at.toString(), nonce)
			.joinToString("\n")
			.toByteArray(Charsets.UTF_8)

	fun keyReceiptSigningBytes(
		domainId: String,
		recipientSignPub: String,
		epoch: Long,
		at: Long,
		nonce: String,
	): ByteArray =
		listOf(Protocol.Wire.SIGNING_TAG_KEY_RECEIPT, domainId, recipientSignPub, epoch.toString(), at.toString(), nonce)
			.joinToString("\n")
			.toByteArray(Charsets.UTF_8)

	private fun deriveKey(shared: ByteArray, ephemeralPub: ByteArray): ByteArray {
		val hkdf = HKDFBytesGenerator(SHA256Digest())
		hkdf.init(HKDFParameters(shared, ephemeralPub, HKDF_INFO))
		val out = ByteArray(32)
		hkdf.generateBytes(out, 0, 32)
		return out
	}

	fun seal(plaintext: ByteArray, recipientBoxPubB64: String, senderSignPrivB64: String): SealedEnvelope {
		val ephPriv = X25519PrivateKeyParameters(rnd)
		val ephPub = ephPriv.generatePublicKey().encoded
		val shared = ByteArray(32)
		X25519Agreement().apply { init(ephPriv) }.calculateAgreement(X25519PublicKeyParameters(unb64(recipientBoxPubB64), 0), shared, 0)
		val key = deriveKey(shared, ephPub)
		val nonce = ByteArray(Protocol.Wire.CONTENT_NONCE_BYTES).also { rnd.nextBytes(it) }
		val cipher = GCMBlockCipher.newInstance(AESEngine.newInstance())
		cipher.init(true, AEADParameters(KeyParameter(key), 128, nonce))
		val out = ByteArray(cipher.getOutputSize(plaintext.size))
		var len = cipher.processBytes(plaintext, 0, plaintext.size, out, 0)
		len += cipher.doFinal(out, len)
		val sealed = out.copyOf(len) // ct||tag
		return SealedEnvelope(b64(ephPub), b64(nonce), b64(sealed), sign(ephPub + nonce + sealed, senderSignPrivB64))
	}

	/** Verifies the expected sender before decrypting for this recipient. */
	fun unseal(env: SealedEnvelope, recipientBoxPrivB64: String, senderSignPubB64: String): ByteArray {
		val ephPub = unb64(env.ephemeralPub)
		val nonce = unb64(env.nonce)
		val sealed = unb64(env.ciphertext)
		if (!verify(ephPub + nonce + sealed, env.signature, senderSignPubB64)) {
			throw SecurityException("seal: bad signature")
		}
		val shared = ByteArray(32)
		X25519Agreement().apply { init(X25519PrivateKeyParameters(unb64(recipientBoxPrivB64), 0)) }
			.calculateAgreement(X25519PublicKeyParameters(ephPub, 0), shared, 0)
		val key = deriveKey(shared, ephPub)
		val cipher = GCMBlockCipher.newInstance(AESEngine.newInstance())
		cipher.init(false, AEADParameters(KeyParameter(key), 128, nonce))
		val out = ByteArray(cipher.getOutputSize(sealed.size))
		var len = cipher.processBytes(sealed, 0, sealed.size, out, 0)
		len += cipher.doFinal(out, len) // verifies the tag
		return out.copyOf(len)
	}

	fun deriveContentKey(signPrivB64: String, domainId: String, epoch: Int): ByteArray {
		require(epoch >= 1) { "content epoch must be an integer from 1" }
		val signPriv = unb64(signPrivB64).also { require(it.size == 32) { "content signing key must be 32 bytes" } }
		val hkdf = HKDFBytesGenerator(SHA256Digest())
		hkdf.init(
			HKDFParameters(
				signPriv,
				CONTENT_SALT,
				"$CONTENT_INFO_PREFIX$domainId\n$epoch".toByteArray(Charsets.UTF_8),
			),
		)
		return ByteArray(32).also { hkdf.generateBytes(it, 0, it.size) }
	}

	fun sealContent(
		plaintext: ByteArray,
		key: ByteArray,
		aad: ContentAad,
		nonce: ByteArray = ByteArray(Protocol.Wire.CONTENT_NONCE_BYTES).also { rnd.nextBytes(it) },
	): ContentEnvelope {
		require(key.size == 32) { "content key must be 32 bytes" }
		require(nonce.size == Protocol.Wire.CONTENT_NONCE_BYTES) { "content nonce must be 12 bytes" }
		val cipher = GCMBlockCipher.newInstance(AESEngine.newInstance())
		cipher.init(true, AEADParameters(KeyParameter(key), 128, nonce, aad.bytes()))
		val out = ByteArray(cipher.getOutputSize(plaintext.size))
		var len = cipher.processBytes(plaintext, 0, plaintext.size, out, 0)
		len += cipher.doFinal(out, len)
		return ContentEnvelope(v = 1L, epoch = aad.epoch.toLong(), nonce = b64(nonce), ciphertext = b64(out.copyOf(len)))
	}

	fun openContent(env: ContentEnvelope, key: ByteArray, aad: ContentAad): ByteArray {
		if (env.v != 1L) throw IllegalArgumentException("content envelope version is unsupported")
		if (env.epoch != aad.epoch.toLong()) throw IllegalArgumentException("content envelope epoch does not match AAD")
		require(key.size == 32) { "content key must be 32 bytes" }
		val nonce = unb64(env.nonce)
		require(nonce.size == Protocol.Wire.CONTENT_NONCE_BYTES) { "content nonce must be 12 bytes" }
		val sealed = unb64(env.ciphertext)
		if (sealed.size < 16) throw IllegalArgumentException("content ciphertext is too short")
		val cipher = GCMBlockCipher.newInstance(AESEngine.newInstance())
		cipher.init(false, AEADParameters(KeyParameter(key), 128, nonce, aad.bytes()))
		val out = ByteArray(cipher.getOutputSize(sealed.size))
		var len = cipher.processBytes(sealed, 0, sealed.size, out, 0)
		len += cipher.doFinal(out, len)
		return out.copyOf(len)
	}

	fun wrapContentKey(
		key: ByteArray,
		epoch: Int,
		recipientBoxPubB64: String,
		senderSignPubB64: String,
		senderSignPrivB64: String,
	): KeyEnvelope {
		require(key.size == 32) { "content key must be 32 bytes" }
		require(epoch >= 1) { "content epoch must be an integer from 1" }
		val body = keyEnvelopePreimage(epoch, key)
		val sealed = seal(body, recipientBoxPubB64, senderSignPrivB64)
		return KeyEnvelope(
			epoch.toLong(),
			senderSignPubB64,
			ProtoSealedEnvelope(sealed.ephemeralPub, sealed.nonce, sealed.ciphertext, sealed.signature),
		)
	}

	fun keyEnvelopePreimage(epoch: Int, key: ByteArray): ByteArray {
		require(epoch >= 1) { "content epoch must be an integer from 1" }
		require(key.size == 32) { "content key must be 32 bytes" }
		return "${Protocol.Wire.SIGNING_TAG_KEY_ENVELOPE}\n$epoch\n".toByteArray(Charsets.UTF_8) + key
	}

	fun unwrapContentKey(env: KeyEnvelope, recipientBoxPrivB64: String): Pair<Int, ByteArray> {
		if (env.epoch < 1 || env.epoch > Int.MAX_VALUE) throw IllegalArgumentException("content epoch is invalid")
		val sealed = env.sealed
		val key = unseal(
			SealedEnvelope(sealed.ephemeralPub, sealed.nonce, sealed.ciphertext, sealed.signature),
			recipientBoxPrivB64,
			env.signerSignPub,
		)
		val preimage = keyEnvelopePreimage(env.epoch.toInt(), ByteArray(32))
		val bodyPrefix = preimage.copyOfRange(0, preimage.size - 32)
		if (key.size != bodyPrefix.size + 32 || !key.copyOfRange(0, bodyPrefix.size).contentEquals(bodyPrefix)) {
			throw IllegalArgumentException("content key envelope body is invalid")
		}
		val contentKey = key.copyOfRange(bodyPrefix.size, key.size)
		return env.epoch.toInt() to contentKey
	}

	/** SHA-256 fingerprint (first 8 bytes, grouped hex) for the enrollment SAS. */
	fun fingerprint(pubB64: String): String {
		val hash = MessageDigest.getInstance("SHA-256").digest(unb64(pubB64))
		val hex = hash.copyOf(8).joinToString("") { "%02X".format(it) }
		return hex.chunked(4).joinToString("-")
	}
}
