package com.atelier_nyaarium.switchboard.crypto

import java.security.MessageDigest
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

/**
 * Federation crypto, the byte-exact Kotlin counterpart of switchboard's
 * `src/shared/crypto.ts`. Uses BouncyCastle's LOW-LEVEL API directly (no Security
 * provider registered, so there is no Android BouncyCastle conflict). The wire
 * format - raw 32-byte keys (base64), ephemeral X25519 box -> HKDF-SHA256 ->
 * AES-256-GCM with an Ed25519 signature over ephemeralPub||nonce||ct+tag -
 * matches node:crypto exactly so the two platforms interop. The cross-platform
 * vectors in CryptoTest pin this.
 */
object Crypto {
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
		val nonce = ByteArray(12).also { rnd.nextBytes(it) }
		val cipher = GCMBlockCipher.newInstance(AESEngine.newInstance())
		cipher.init(true, AEADParameters(KeyParameter(key), 128, nonce))
		val out = ByteArray(cipher.getOutputSize(plaintext.size))
		var len = cipher.processBytes(plaintext, 0, plaintext.size, out, 0)
		len += cipher.doFinal(out, len)
		val sealed = out.copyOf(len) // ct||tag
		return SealedEnvelope(b64(ephPub), b64(nonce), b64(sealed), sign(ephPub + nonce + sealed, senderSignPrivB64))
	}

	/** Verify the sender's signature (against the EXPECTED sender key the caller
	 * resolved from the allowlist), then decrypt with the recipient's box private
	 * key. Throws on tamper / wrong sender / wrong recipient. */
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

	/** SHA-256 fingerprint (first 8 bytes, grouped hex) for the enrollment SAS. */
	fun fingerprint(pubB64: String): String {
		val hash = MessageDigest.getInstance("SHA-256").digest(unb64(pubB64))
		val hex = hash.copyOf(8).joinToString("") { "%02X".format(it) }
		return hex.chunked(4).joinToString("-")
	}
}
