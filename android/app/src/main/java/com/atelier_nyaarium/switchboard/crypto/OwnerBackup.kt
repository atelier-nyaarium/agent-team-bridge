package com.atelier_nyaarium.switchboard.crypto

import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.bouncycastle.crypto.engines.AESEngine
import org.bouncycastle.crypto.generators.SCrypt
import org.bouncycastle.crypto.modes.GCMBlockCipher
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.KeyParameter

/**
 * Passphrase-encrypted backup of the owner root key, the one artifact worth safeguarding
 * offline (anyone with the blob AND the passphrase controls the mesh). A memory-hard
 * scrypt KDF turns the passphrase into the AES-256-GCM key, so a stolen blob resists
 * offline cracking. The app never auto-uploads this; the user keeps it themselves.
 */
object OwnerBackup {
	// Interactive scrypt cost: N=2^15, r=8, p=1 (~100ms on a phone, ~32 MB). Memory-hard
	// enough to make offline guessing expensive without a noticeable export delay.
	private const val N = 1 shl 15
	private const val R = 8
	private const val P = 1
	private const val KEY_LEN = 32

	@Serializable
	data class Blob(val v: Int = 1, val salt: String, val nonce: String, val ciphertext: String)

	private val rnd = SecureRandom()
	private val json = Json { ignoreUnknownKeys = true }

	private fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
	private fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)

	private fun derive(passphrase: String, salt: ByteArray): ByteArray =
		SCrypt.generate(passphrase.toByteArray(Charsets.UTF_8), salt, N, R, P, KEY_LEN)

	private fun aesGcm(encrypt: Boolean, key: ByteArray, nonce: ByteArray, input: ByteArray): ByteArray {
		val cipher = GCMBlockCipher.newInstance(AESEngine.newInstance())
		cipher.init(encrypt, AEADParameters(KeyParameter(key), 128, nonce))
		val out = ByteArray(cipher.getOutputSize(input.size))
		var len = cipher.processBytes(input, 0, input.size, out, 0)
		len += cipher.doFinal(out, len)
		return out.copyOf(len)
	}

	/** Seal a plaintext (the serialized owner identity) under the passphrase. */
	fun export(plaintext: String, passphrase: String): String {
		val salt = ByteArray(16).also { rnd.nextBytes(it) }
		val nonce = ByteArray(12).also { rnd.nextBytes(it) }
		val ct = aesGcm(true, derive(passphrase, salt), nonce, plaintext.toByteArray(Charsets.UTF_8))
		return json.encodeToString(Blob.serializer(), Blob(salt = b64(salt), nonce = b64(nonce), ciphertext = b64(ct)))
	}

	/** Open a backup blob with the passphrase. Throws on a wrong passphrase or tamper
	 * (the GCM tag fails to verify). */
	fun restore(blobJson: String, passphrase: String): String {
		val blob = json.decodeFromString(Blob.serializer(), blobJson)
		val pt = aesGcm(false, derive(passphrase, unb64(blob.salt)), unb64(blob.nonce), unb64(blob.ciphertext))
		return pt.toString(Charsets.UTF_8)
	}
}
