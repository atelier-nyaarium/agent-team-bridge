package com.atelier_nyaarium.switchboard.enroll

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The owner-device enrollment screen: scan a typed QR, confirm its SAS
 * fingerprint out-of-band, then redeem (enroll-owner) or owner-sign + submit an
 * admission (admit-switch / authorize-phone). The signing happens locally; only the
 * signed artifact + the device's public keys leave the phone.
 */
@Composable
fun EnrollScreen(controller: EnrollmentController, onBack: () -> Unit) {
	var scanned by remember { mutableStateOf<EnrollmentPayload?>(null) }
	var status by remember { mutableStateOf<String?>(null) }
	var busy by remember { mutableStateOf(false) }
	val scope = rememberCoroutineScope()

	val scanLauncher =
		rememberLauncherForActivityResult(ScanContract()) { result ->
			val contents = result.contents
			when {
				contents == null -> {
					DebugLog.log("Enroll", "scan returned no contents (cancelled or nothing decoded)")
					status = "Scan cancelled."
				}
				else -> {
					// Length only, never the contents: the QR carries a single-use secret.
					DebugLog.log("Enroll", "scan decoded ${contents.length} chars")
					val payload = parseEnrollmentPayload(contents)
					if (payload == null) {
						DebugLog.log("Enroll", "payload did not parse as an enrollment code")
						status = "That QR is not a switchboard enrollment code."
					} else {
						DebugLog.log("Enroll", "payload parsed: ${payloadTitle(payload)}")
						scanned = payload
						status = null
					}
				}
			}
		}

	fun launchScan() {
		status = null
		DebugLog.log("Enroll", "launching QR scanner")
		val options =
			ScanOptions()
				.setDesiredBarcodeFormats(ScanOptions.QR_CODE)
				.setOrientationLocked(false)
				.setBeepEnabled(false)
				.setPrompt("Point at the enrollment QR")
		scanLauncher.launch(options)
	}

	fun submit(payload: EnrollmentPayload) {
		busy = true
		status = null
		DebugLog.log("Enroll", "submitting ${payloadTitle(payload)}")
		scope.launch {
			val result =
				withContext(Dispatchers.IO) {
					runCatching {
						when (payload) {
							is EnrollmentPayload.EnrollOwner -> controller.redeemOwner(payload)
							is EnrollmentPayload.AdmitSwitch -> controller.admitSwitch(payload)
							is EnrollmentPayload.AuthorizePhone -> controller.authorizePhone(payload)
						}
					}
				}
			busy = false
			result
				.onSuccess { r: EnrollResult ->
					if (r.ok) {
						DebugLog.log("Enroll", "enrolled OK")
						status = "Enrolled."
						scanned = null
					} else {
						DebugLog.log("Enroll", "rejected: ${r.error ?: "unknown"}")
						status = "Rejected: ${r.error ?: "unknown"}"
					}
				}
				.onFailure {
					DebugLog.log("Enroll", "failed: ${it.message}")
					status = "Failed: ${it.message}"
				}
		}
	}

	Column(
		// systemBarsPadding keeps the title clear of the status bar and the Back
		// button clear of the nav bar (targetSdk 35 forces edge-to-edge, and this
		// screen has no Scaffold to apply the insets for it).
		modifier = Modifier.fillMaxSize().systemBarsPadding().padding(16.dp).verticalScroll(rememberScrollState()),
		verticalArrangement = Arrangement.spacedBy(12.dp),
	) {
		Text("Enrollment", style = MaterialTheme.typography.headlineSmall)
		Text(
			if (controller.isEnrolledOwner()) {
				"This device is an owner device. Scan an arbiter or second-device QR to admit it."
			} else {
				"Scan evie's enroll-owner QR to make this device the Domain owner."
			},
			style = MaterialTheme.typography.bodyMedium,
		)

		when (val payload = scanned) {
			null -> {
				Button(onClick = ::launchScan, modifier = Modifier.fillMaxWidth()) { Text("Scan QR") }
			}
			else -> {
				Card(modifier = Modifier.fillMaxWidth()) {
					Column(
						modifier = Modifier.padding(16.dp),
						verticalArrangement = Arrangement.spacedBy(8.dp),
					) {
						Text(payloadTitle(payload), style = MaterialTheme.typography.titleMedium)
						payloadDetail(payload)?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
						Spacer(Modifier.height(4.dp))
						Text("Confirm this fingerprint matches the one shown out-of-band:")
						Text(
							payload.sas(),
							style = MaterialTheme.typography.titleLarge,
							fontFamily = FontFamily.Monospace,
							textAlign = TextAlign.Center,
							modifier = Modifier.fillMaxWidth(),
						)
					}
				}
				Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
					OutlinedButton(enabled = !busy, onClick = { scanned = null }, modifier = Modifier.weight(1f)) {
						Text("Cancel")
					}
					Button(enabled = !busy, onClick = { submit(payload) }, modifier = Modifier.weight(1f)) {
						Text(if (busy) "Working..." else "Confirm & enroll")
					}
				}
			}
		}

		status?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }

		Spacer(Modifier.height(8.dp))
		OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Back") }
	}
}

private fun payloadTitle(payload: EnrollmentPayload): String =
	when (payload) {
		is EnrollmentPayload.EnrollOwner -> "Become the Domain owner"
		is EnrollmentPayload.AdmitSwitch -> "Admit Switch \"${payload.switchId}\""
		is EnrollmentPayload.AuthorizePhone -> "Authorize a second owner device"
	}

private fun payloadDetail(payload: EnrollmentPayload): String? =
	when (payload) {
		is EnrollmentPayload.EnrollOwner -> "Domain ${payload.domainId} at ${payload.evieAddr}"
		is EnrollmentPayload.AdmitSwitch -> null
		is EnrollmentPayload.AuthorizePhone -> "Domain ${payload.domainId}"
	}
