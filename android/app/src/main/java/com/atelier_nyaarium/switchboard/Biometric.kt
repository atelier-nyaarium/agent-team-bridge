package com.atelier_nyaarium.switchboard

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

private const val AUTHENTICATORS =
	BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL

fun deviceCanAuthenticate(activity: FragmentActivity): Boolean =
	BiometricManager.from(activity).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS

/** Show the biometric / device-credential prompt. Unlocks open if nothing is enrolled. */
fun promptUnlock(activity: FragmentActivity, onResult: (Boolean) -> Unit) {
	if (!deviceCanAuthenticate(activity)) {
		onResult(true)
		return
	}
	val prompt = BiometricPrompt(
		activity,
		ContextCompat.getMainExecutor(activity),
		object : BiometricPrompt.AuthenticationCallback() {
			override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onResult(true)
			override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onResult(false)
		},
	)
	val info = BiometricPrompt.PromptInfo.Builder()
		.setTitle("Unlock Switchboard")
		.setSubtitle("Authenticate to access your chats")
		.setAllowedAuthenticators(AUTHENTICATORS)
		.build()
	prompt.authenticate(info)
}
