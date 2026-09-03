package com.atelier_nyaarium.switchboard.crypto

import java.security.SecureRandom
import java.util.Base64

private val nonceRandom = SecureRandom()

/** Wire nonces are base64; a UUID string fails the Router's field check. */
fun randomNonceB64(bytes: Int = 18): String {
	val buffer = ByteArray(bytes)
	nonceRandom.nextBytes(buffer)
	return Base64.getEncoder().encodeToString(buffer)
}
