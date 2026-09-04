package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.randomNonceB64
import java.security.SecureRandom
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class PhoneAmbient(
	val now: () -> Long,
	val newNonce: () -> String,
	val newNonceBytes: () -> ByteArray,
	val newOpId: () -> String,
	val wrapEntropy: (Int) -> ByteArray,
	val missingTimer: MissingEpochTimer,
) {
	companion object {
		fun system(): PhoneAmbient {
			val random = SecureRandom()
			return PhoneAmbient(
				now = { System.currentTimeMillis() },
				newNonce = ::randomNonceB64,
				newNonceBytes = { ByteArray(12).also(random::nextBytes) },
				newOpId = { UUID.randomUUID().toString() },
				wrapEntropy = { size -> ByteArray(size).also(random::nextBytes) },
				missingTimer = CoroutineMissingEpochTimer(),
			)
		}
	}
}

internal class CoroutineMissingEpochTimer : MissingEpochTimer {
	private val scope = CoroutineScope(Dispatchers.IO)

	override fun schedule(delayMs: Long, task: suspend () -> Unit) {
		scope.launch {
			if (delayMs > 0) delay(delayMs)
			task()
		}
	}
}
